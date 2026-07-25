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
