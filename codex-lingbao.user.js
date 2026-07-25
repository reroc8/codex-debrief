/*
@codex-plus-script
name: CODEX 灵宝
description: AI 回完话后自动用大白话播报它干了啥（输出翻译层）。治"不知 AI 动了啥、还要自己搜/翻英文"。
version: 0.1.0
author: reroc8
*/

// ============================================================================
// 内联：规则翻译器（由 build.js 从 announcer-translator.js 注入，单一可信源）
// 修改翻译逻辑请改 announcer-translator.js 后跑 `node build.js`，不要手写这里。
// ==TRANSLATOR:START==
/*
 * announcer-translator.js — CODEX 灵宝 规则翻译器（零依赖、不调 AI）
 * 单一可信源：本文件同时被 node 测试 require，以及被 build.js 内联进
 * codex-lingbao.user.js。不要手写两份，改这里、跑 build 即可。
 *
 * 输入：AI 回复的纯文本
 * 输出：translate(text) → 结构化结果；renderBlocks(result) → 四块大白话
 *
 * 设计原则（来自评审 v0.3.1）：
 *  - 命令分四类：已执行 / 建议用户执行 / 仅提及 / 无法判断
 *  - 否定句、".env.example" 不误报
 *  - 输出固定四块：完成状态 / 改了什么 / 验证结果 / 你要做什么
 *  - 风险只在有实际依据时出现
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.__announcerTranslator = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 文件路径：支持 Windows(C:\...) 与 Unix 路径 ----
  // 前置：非文件名字符（含中文、CJK 标点）；后置：非负则文件名字符（避免截断 .env.example / 中文逗号）
  const FILE_RE = /(?:^|[^A-Za-z0-9_/\\])((?:[A-Za-z]:[\\])?(?:[\w.@~-]+[\\/])*[\w.@-]*\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|vue|svelte|html|css|scss|less|json|ya?ml|toml|ini|conf|cfg|env|md|txt|sql|sh|bat|ps1|plist|xml|lock))(?![A-Za-z0-9])/gm;

  // 动作词 → 中文（英文 + 中文都识别）
  const ACTIONS = [
    { re: /\b(creat\w*|added?|new file|wrote|writing)\b|新建|创建|新增|写入/i, zh: '新建/写入' },
    { re: /\b(modif\w*|updat\w*|chang\w*|edit\w*|refactor\w*)\b|修改|更新|调整|重构/i, zh: '修改' },
    { re: /\b(delet\w*|remov\w*)\b|删除|移除/i, zh: '删除' },
    { re: /\b(renam\w*|mov\w*)\b|重命名|移动/i, zh: '移动/改名' },
    { re: /\b(install\w*)\b|安装/i, zh: '安装' },
    { re: /\b(fix\w*|repair\w*)\b|修复|修好/i, zh: '修复' },
    { re: /\b(test\w*|ran tests?)\b|测试/i, zh: '测试' },
  ];

  // 命令行：行首、$ 后、或反引号内
  const CMD_WORDS = 'npm|npx|pnpm|yarn|bun|pip3?|python3?|node|git|docker|docker-compose|cargo|go|make|brew|curl|wget|mkdir|cp|mv|rm|chmod|bash|sh|cd';
  const CMD_LINE_RE = new RegExp('(?:^|\\n)\\s*(?:\\$\\s*)?((?:' + CMD_WORDS + ')\\s+[^\\n`]{2,80})', 'gm');
  const CMD_TICK_RE = new RegExp('`((?:' + CMD_WORDS + ')\\s+[^`\\n]{2,80})`', 'g');
  // 散文式已执行命令：运行了/ran 之后紧跟的命令（含 "ran: x"）
  const CMD_PROSE_RE = new RegExp('(?:运行了|跑了|执行了|ran|executed|completed running|just ran|has been run)\\s*[:：]?\\s*((?:' + CMD_WORDS + ')\\s+[^，。\\n`]{2,60})', 'gi');

  // 报错信号
  const ERROR_RE = /\b(error|failed|failure|exception|traceback|cannot|unable to|fatal|panic)\b|报错|错误|失败|异常|崩溃/i;

  // 风险信号（删除多、动数据库、动密钥类）
  const RISK_RULES = [
    // 密钥/密码类：遇到 .env.example 不算泄露（见 detectRisks）
    { re: /\.(pem|key|secret)|password|api[_ -]?key|token|密钥|密码/i, zh: '碰到了密钥/密码类内容，注意别外泄' },
    { re: /\b(drop|truncate|delete from)\b|删库|清空表/i, zh: '涉及数据库删除，先确认有备份' },
    { re: /rm\s+-rf|del\s+\/s/i, zh: '出现了强力删除命令，确认删的是什么' },
  ];

  // "完成"声明
  const DONE_RE = /\b(done|completed?|finished|success(?:fully)?|all set|works? now)\b|完成|搞定|已修复|成功|好了/i;
  // "让用户做什么"
  const TODO_USER_RE = /\b(you (?:can|should|need to)|please (?:run|restart|check|verify|install|execute))\b|你可以|你需要|请(?:运行|重启|检查|验证|安装|执行)|建议(你)?运行/i;

  // 否定词（含否定则下调可信度）。中文无 \b，英文部分单独加前边界
  const NEG_RE = /\b(not |n't |didn'?t|doesn'?t|won'?t|can'?t|couldn'?t|shouldn'?t|without)|没有|未|别|无需|不必|不\s*(运行|执行|安装|修改|删除)/i;

  function uniq(arr) { return Array.from(new Set(arr)); }
  function sentences(t) { return t.split(/(?<=[。.!?！？\n])\s*/); }
  function hasNeg(s) { return NEG_RE.test(s); }

  function extractFiles(text) {
    const out = [];
    let m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(text)) !== null) {
      const f = m[1];
      // 过滤掉纯单词（无扩展名前的点）
      if (/^[\w.-]+$/.test(f) && !f.includes('.')) continue;
      out.push(f);
    }
    return uniq(out).slice(0, 12);
  }

  function extractCommands(text) {
    const out = [];
    let m;
    CMD_LINE_RE.lastIndex = 0;
    while ((m = CMD_LINE_RE.exec(text)) !== null) out.push(m[1].trim());
    CMD_TICK_RE.lastIndex = 0;
    while ((m = CMD_TICK_RE.exec(text)) !== null) out.push(m[1].trim());
    CMD_PROSE_RE.lastIndex = 0;
    while ((m = CMD_PROSE_RE.exec(text)) !== null) out.push(m[1].trim());
    return uniq(out).slice(0, 8);
  }

  // 找包含某片段的句子（用于命令分类的上下文判断）
  function sentenceOf(text, frag) {
    const ss = sentences(text);
    if (!frag) return text;
    for (const s of ss) if (s.indexOf(frag) >= 0) return s;
    return text;
  }

  // 命令四分类：executed / suggested / mentioned / unknown
  function classifyCommand(cmd, text) {
    const s = sentenceOf(text, cmd);
    if (hasNeg(s)) return 'unknown';
    if (/(i\s+(ran|executed|run)|i'?ve run|i have run|已?运行了|我运行|执行了|successfully (installed|ran)|completed running|ran `|executed `|just ran|has been run)/i.test(s)) return 'executed';
    if (/(please (run|execute|restart|install)|you (should|can|need to) (run|execute|install|restart)|你需要(运行|执行|安装|重启)|请(运行|执行|安装|重启)|建议(你)?运行|run the following|try running|to run|run this|^(?:run|execute)\s+[`'"\w])/i.test(s)) return 'suggested';
    if (/(command|命令|比如|例如|such as|via `|using `|e\.g\.)/i.test(s)) return 'mentioned';
    return 'unknown';
  }

  function detectActions(text) {
    const ss = sentences(text);
    const hit = [];
    for (const a of ACTIONS) {
      // 任一句含动作词且无否定 → 计入
      for (const s of ss) {
        if (a.re.test(s) && !hasNeg(s)) { hit.push(a.zh); break; }
      }
    }
    return uniq(hit);
  }

  function detectRisks(text) {
    return RISK_RULES.filter(r => {
      // .env.example 不算密钥泄露
      if (/\.env\.example/i.test(text) && r.zh.includes('密钥')) return false;
      return r.re.test(text);
    }).map(r => r.zh);
  }

  /**
   * 主入口：把 AI 回复文本翻成大白话播报
   * @returns {{
   *   status:'done'|'error'|'none',
   *   changed:string[], verification:string, todo:string[], risks:string[],
   *   files:string[], commands:{cmd:string,kind:string}[], errors:boolean, actions:string[]
   * }}
   */
  function translate(text) {
    const t = String(text || '');
    const files = extractFiles(t);
    const commandsRaw = extractCommands(t);
    const commands = commandsRaw.map(c => ({ cmd: c, kind: classifyCommand(c, t) }));
    const actions = detectActions(t);
    const warnings = detectRisks(t);
    const hasError = ERROR_RE.test(t);
    const saidDone = DONE_RE.test(t);
    const needsYou = TODO_USER_RE.test(t);
    const fixed = actions.indexOf('修复') >= 0;

    // 完成状态
    let status;
    if (hasError && !saidDone && !fixed) status = 'error';
    else if (saidDone || fixed || actions.length || files.length || commands.some(c => c.kind === 'executed')) status = 'done';
    else status = 'none';

    // 改了什么
    const changed = [];
    if (files.length) {
      const act = actions.length ? actions.join('、') : '改动';
      changed.push('动过 ' + files.length + ' 个文件（' + act + '）：' + files.slice(0, 5).join('、') + (files.length > 5 ? ' 等' : ''));
    } else if (actions.length) {
      changed.push('做了这些事：' + actions.join('、'));
    }

    // 命令分类汇总
    const executed = commands.filter(c => c.kind === 'executed').map(c => c.cmd);
    const suggested = commands.filter(c => c.kind === 'suggested').map(c => c.cmd);
    const unknown = commands.filter(c => c.kind === 'unknown').map(c => c.cmd);
    const mentioned = commands.filter(c => c.kind === 'mentioned').map(c => c.cmd);
    if (executed.length) changed.push('它自己跑了 ' + executed.length + ' 条命令（' + executed.slice(0, 2).join('、') + '）');
    const uncertain = unknown.concat(mentioned);
    if (uncertain.length) changed.push('回复提到 ' + uncertain.length + ' 条命令（' + uncertain[0] + '），但不能确认是否已经执行');

    // 验证结果
    let verification;
    if (hasError) verification = '提到报错/失败，建议追问"这个错要紧吗、要不要我处理"';
    else if (saidDone || executed.length || fixed) verification = '看起来跑通了（基于它说的"完成"/执行的命令/已修复）';
    else verification = '未检测到明确的验证/测试结果';

    // 你要做什么
    const todo = [];
    if (suggested.length) todo.push('需要你运行：' + suggested.join('；'));
    if (needsYou && !suggested.length) todo.push('它让你做点什么（运行/重启/检查），往上翻找原文');
    if (!todo.length) todo.push('暂时不需要你做额外操作');

    return {
      status, changed, verification, todo, risks: warnings,
      files, commands, errors: hasError, actions,
    };
  }

  // 四块固定输出；风险只在有依据时出现
  function renderBlocks(r) {
    const lines = [];
    const statusMap = {
      done: '✅ 完成状态：它说完成了',
      error: '⚠️ 完成状态：它提到报错/失败',
      none: '💬 完成状态：主要是在解释，没看到明确完成声明',
    };
    lines.push(statusMap[r.status] || statusMap.none);
    lines.push('📦 改了什么：' + (r.changed.length ? r.changed.join('；') : '未检测到改文件或跑命令'));
    lines.push('🧪 验证结果：' + r.verification);
    lines.push('👉 你要做什么：' + r.todo.join('；'));
    r.risks.forEach(w => lines.push('🚨 风险：' + w));
    return lines.join('\n');
  }

  return { translate, renderBlocks, classifyCommand, extractFiles, extractCommands };
});

// ==TRANSLATOR:END==
// ============================================================================

// ============================================================================
// 主逻辑：监听 AI 回复 → 等生成结束 → 哈希去重 → 用大白话播报
// ============================================================================
(() => {
  'use strict';

  const API_KEY = '__codexAnnouncer';
  const DEBUG_PREFIX = '[灵宝]';
  const STREAM_IDLE_MS = 1300; // 文本稳定超过 1.3s 视为生成结束（对齐官方 stepwise 实现）

  const previous = window[API_KEY];
  if (previous && typeof previous.destroy === 'function') {
    try { previous.destroy(); } catch (_) {}
  }

  const CONFIG = {
    debug: false, // 默认关闭：不扫描全页、不描红、不打印回复内容
    title: '🤖 CODEX 灵宝',
    maxCards: 10,
    debounceMs: 150,
    // 容器与消息节点的多级兜底（对齐最新 Codex++ 结构）
    rootSel: '.thread-scroll-container, [data-testid*="thread" i], main, [role="main"], #conversation, .conversation',
    msgSel: '[data-message-author-role], [data-thread-find-target], [data-testid*="message" i], [data-test-id*="message" i], article',
  };

  const state = {
    observer: null, disposed: false,
    panel: null, logEl: null, counterEl: null,
    cards: new Map(),         // nodeId -> cardEl（插入顺序即展示顺序）
    captured: 0,
    current: null,            // { nodeId, hash, text, timer }
    seenHashes: new Set(),    // 去重：相同文本不重复播报
  };

  // ---------- DOM 工具 ----------
  function visible(el) {
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch (e) { return false; }
  }
  function pick(root, sel) {
    for (const s of sel.split(',').map(s => s.trim())) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }
  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function nodeId(el) {
    if (el.dataset && el.dataset.messageAuthorRole && el.dataset.msgId) return 'd:' + el.dataset.msgId;
    if (!el.__annId) el.__annId = 'm' + Math.random().toString(36).slice(2);
    return el.__annId;
  }
  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function compactSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return tag + id + cls;
  }

  // ---------- 选择器：找最新的 AI 回复节点 ----------
  function chatRoot() {
    for (const s of CONFIG.rootSel.split(',').map(s => s.trim())) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return document.body;
  }

  function isAssistantNode(n) {
    const role = (n.getAttribute && n.getAttribute('data-message-author-role') || '').toLowerCase();
    if (role === 'assistant' || role === 'system') return true;
    if (role === 'user') return false;
    // 兜底：类启发式（对齐官方 .group.flex.min-w-0.flex-col 且非 items-end）
    const cls = (n.className || '');
    if (typeof cls === 'string' && /group\s+flex\s+min-w-0\s+flex-col/.test(cls) && !/items-end/.test(cls)) return true;
    return false;
  }

  function getAssistantNodes(root) {
    let nodes = [];
    try { nodes = Array.from(root.querySelectorAll(CONFIG.msgSel)); } catch (e) { nodes = []; }
    let out = nodes.filter(isAssistantNode).filter(visible);
    if (!out.length) {
      // 二次兜底：仅用类启发式
      out = nodes.filter(n => {
        const cls = (n.className || '');
        return typeof cls === 'string' && /group\s+flex\s+min-w-0\s+flex-col/.test(cls) && !/items-end/.test(cls) && visible(n);
      });
    }
    return out;
  }

  function getLatestAssistantNode() {
    const root = chatRoot();
    const nodes = getAssistantNodes(root);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  // ---------- 面板 ----------
  function ensurePanel() {
    if (state.panel) return;
    const p = document.createElement('div');
    p.setAttribute('data-announcer', '1');
    p.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
      'width:360px', 'max-height:46vh', 'overflow:auto',
      'background:#0f1115', 'color:#e6e6e6', 'border:1px solid #2a2f3a',
      'border-radius:12px', 'box-shadow:0 8px 30px rgba(0,0,0,.45)',
      'font:13px/1.55 -apple-system,system-ui,sans-serif', 'padding:10px 12px'
    ].join(';');
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px">' +
        '<b style="font-size:13px">' + CONFIG.title + '</b>' +
        '<span data-ann-counter style="color:#7fd1ff;font-size:11px">已播报 0 条</span>' +
        '<span style="margin-left:auto;display:flex;gap:4px">' +
          '<button data-ann-min title="最小化" style="cursor:pointer;background:#1b2030;color:#cfd6e2;border:1px solid #2a2f3a;border-radius:6px;width:22px;height:20px">－</button>' +
          '<button data-ann-copy title="复制" style="cursor:pointer;background:#1b2030;color:#cfd6e2;border:1px solid #2a2f3a;border-radius:6px;width:22px;height:20px">⧉</button>' +
          '<button data-ann-close title="关闭" style="cursor:pointer;background:#1b2030;color:#cfd6e2;border:1px solid #2a2f3a;border-radius:6px;width:22px;height:20px">✕</button>' +
        '</span>' +
      '</div>' +
      '<div data-ann-log style="white-space:pre-wrap;color:#b9c0cc;font-size:12px"></div>';
    document.body.appendChild(p);
    state.panel = p;
    state.logEl = p.querySelector('[data-ann-log]');
    state.counterEl = p.querySelector('[data-ann-counter]');

    p.querySelector('[data-ann-min]').addEventListener('click', () => {
      const hidden = state.logEl.style.display === 'none';
      state.logEl.style.display = hidden ? '' : 'none';
      p.style.maxHeight = hidden ? '46vh' : 'auto';
    });
    p.querySelector('[data-ann-copy]').addEventListener('click', () => {
      const txt = Array.from(state.cards.values()).map(c => c.textContent).join('\n\n');
      copyText(txt);
    });
    p.querySelector('[data-ann-close]').addEventListener('click', () => destroy());
  }

  function copyText(txt) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
    } catch (e) {}
  }

  function renderCard(id, text) {
    const tr = window.__announcerTranslator;
    let summary;
    if (tr && tr.renderBlocks && tr.translate) {
      try { summary = tr.renderBlocks(tr.translate(text)); }
      catch (_) { summary = text.length > 300 ? text.slice(0, 300) + '…' : text; }
    } else {
      summary = text.length > 300 ? text.slice(0, 300) + '…' : text;
    }

    let card = state.cards.get(id);
    if (!card) {
      card = document.createElement('div');
      card.setAttribute('data-ann-card', '');
      card.setAttribute('data-card-id', id);
      card.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #232833;white-space:pre-wrap;color:#cdd3df;font-size:12px;line-height:1.55';
      state.cards.set(id, card);
      state.logEl.insertBefore(card, state.logEl.firstChild);
      // 历史最多保留 maxCards 条
      while (state.cards.size > CONFIG.maxCards) {
        const oldId = state.cards.keys().next().value;
        const oldEl = state.cards.get(oldId);
        if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
        state.cards.delete(oldId);
      }
      state.captured += 1;
      state.counterEl.textContent = '已播报 ' + state.captured + ' 条';
    }
    // 更新同一张卡片（生成结束后文本已稳定）
    card.textContent = summary;
  }

  // ---------- 生成结束检测 + 去重 ----------
  function onStable(id) {
    const node = findNodeById(id);
    if (!node) return;
    const text = textOf(node);
    if (!text) return;
    const hash = hashText(text);
    if (state.seenHashes.has(hash)) return; // 哈希去重
    state.seenHashes.add(hash);
    renderCard(id, text);
  }

  function findNodeById(id) {
    const root = chatRoot();
    const nodes = getAssistantNodes(root);
    for (const n of nodes) if (nodeId(n) === id) return n;
    return null;
  }

  function tick() {
    if (state.disposed) return;
    const node = getLatestAssistantNode();
    if (!node) { state.current = null; return; }
    const id = nodeId(node);
    const text = textOf(node);
    if (!text) return;
    const hash = hashText(text);

    if (!state.current || state.current.nodeId !== id) {
      // 新的一条回复开始
      if (state.current && state.current.timer) clearTimeout(state.current.timer);
      state.current = { nodeId: id, hash, text, timer: null };
    } else if (state.current.hash !== hash) {
      // 仍在生成（流式输出变化）
      state.current.hash = hash;
      state.current.text = text;
    }

    // 重新计时：稳定超过 STREAM_IDLE_MS 才提交
    if (state.current.timer) clearTimeout(state.current.timer);
    state.current.timer = setTimeout(() => onStable(id), STREAM_IDLE_MS);
  }

  // ---------- 调试（默认关，仅用于校准选择器） ----------
  function debugCensus() {
    const root = chatRoot();
    const nodes = getAssistantNodes(root);
    console.log(DEBUG_PREFIX, '对话根节点 =', compactSelector(root), '| 候选消息节点 =', nodes.length);
    console.log(DEBUG_PREFIX, '最新 AI 回复命中 =', nodes.length ? compactSelector(nodes[nodes.length - 1]) : '未命中（需校准选择器）');
    // 描红候选节点，6 秒后恢复，避免永久破坏界面
    const outlined = nodes.slice(0, 30);
    outlined.forEach(el => { el.__annOutline = el.style.outline; el.style.outline = '2px solid #ff5c8a'; });
    setTimeout(() => outlined.forEach(el => { if (el.__annOutline !== undefined) el.style.outline = el.__annOutline; }), 6000);
    console.log(DEBUG_PREFIX, '已描红候选节点（6 秒后恢复）。把上面日志发我即可校准选择器。');
  }

  function boot() {
    ensurePanel();
    tick();
    let timer = 0;
    state.observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(tick, CONFIG.debounceMs);
    });
    const root = chatRoot();
    state.observer.observe(root, { childList: true, subtree: true, characterData: true });
    if (CONFIG.debug) setTimeout(debugCensus, 1500);
  }

  function destroy() {
    state.disposed = true;
    if (state.current && state.current.timer) clearTimeout(state.current.timer);
    if (state.observer) state.observer.disconnect();
    if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
    state.cards.clear();
    state.seenHashes.clear();
    console.log(DEBUG_PREFIX, '已销毁。');
  }

  window[API_KEY] = { destroy };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
