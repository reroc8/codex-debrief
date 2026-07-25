/*
 * build.js — 把 announcer-translator.js（单一可信源）内联进 codex-lingbao.user.js
 * 运行：node build.js
 * 改了翻译器逻辑后，必须跑这个再提交，否则发布版会与测试版漂移。
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const srcPath = path.join(dir, 'announcer-translator.js');
const targetPath = path.join(dir, 'codex-lingbao.user.js');

const src = fs.readFileSync(srcPath, 'utf8');
let tpl = fs.readFileSync(targetPath, 'utf8');

const START = '// ==TRANSLATOR:START==';
const END = '// ==TRANSLATOR:END==';

const i = tpl.indexOf(START);
const j = tpl.indexOf(END);
if (i < 0 || j < 0) {
  throw new Error('找不到内联标记 ' + START + ' / ' + END + '，请先在 user.js 中放置标记');
}

const head = tpl.slice(0, i + START.length);
const tail = tpl.slice(j);
const out = head + '\n' + src + '\n' + tail;
fs.writeFileSync(targetPath, out);
console.log('✓ 已将 announcer-translator.js 内联进 codex-lingbao.user.js');
