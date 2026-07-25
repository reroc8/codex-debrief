/*
 * test-translator.js — 用 node:test 真断言，覆盖评审要求的用例
 * 运行：node --test test-translator.js
 * 直接 require 单一可信源 announcer-translator.js（与发布版同源）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { translate, classifyCommand } = require('./announcer-translator.js');

test('中文：新建+改文件+自己跑命令 → 完成/已执行', () => {
  const r = translate('我已经新建了 src/utils/format.js 并修改了 src/index.ts，运行了 npm install，完成');
  assert.strictEqual(r.status, 'done');
  assert.ok(r.files.includes('src/utils/format.js'));
  assert.ok(r.files.includes('src/index.ts'));
  assert.ok(r.commands.some(c => c.cmd.includes('npm install') && c.kind === 'executed'));
  assert.ok(r.changed.join('；').includes('它自己跑了'));
});

test('英文：I created... Run npm install → 建议用户执行，不误报已执行', () => {
  const r = translate(
    "I've created a new file `src/utils/format.js` and modified `src/index.ts` to call it. " +
    'Run `npm install` then `npm run build` to verify. Done!'
  );
  assert.strictEqual(r.status, 'done');
  // 关键回归：之前会把"请运行"误报成"它跑了"
  assert.ok(r.commands.every(c => c.kind !== 'executed'), '不应把建议命令算作已执行');
  assert.ok(r.commands.some(c => c.cmd.includes('npm install') && c.kind === 'suggested'));
  assert.ok(r.commands.some(c => c.cmd.includes('npm run build') && c.kind === 'suggested'));
  assert.ok(r.todo.join('；').includes('需要你运行'));
});

test('Windows 路径：C:\\...\\main.py 能被识别', () => {
  const r = translate('modified C:\\Users\\foo\\src\\main.py.\nI ran: python main.py');
  assert.ok(r.files.includes('C:\\Users\\foo\\src\\main.py'));
  assert.ok(r.commands.some(c => c.cmd === 'python main.py' && c.kind === 'executed'));
});

test('.env.example 不算密钥泄露风险，真实 .env 仍触发', () => {
  const r = translate('Updated .env.example with placeholder keys. Done.');
  assert.ok(r.files.includes('.env'));
  assert.strictEqual(r.risks.length, 0, '不应触发密钥风险');
  const r2 = translate('Updated .env with the real API key.');
  assert.ok(r2.risks.some(x => x.includes('密钥')), '真实 .env 应触发密钥风险');
});

test('错误但已修复 → 完成状态为 done，且提示用户重启', () => {
  const r = translate(
    "There was an error: cannot find module 'lodash'. " +
    "I fixed it by installing lodash. Please restart the dev server."
  );
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.errors, true);
  assert.ok(r.todo.join('；').includes('重启'), '应提示用户重启 dev server');
});

test('用户操作（Please run）只算 suggested，不报已执行', () => {
  const r = translate('Please run `npm test` to verify.');
  assert.ok(r.commands.every(c => c.kind !== 'executed'));
  assert.ok(r.commands.some(c => c.cmd.includes('npm test') && c.kind === 'suggested'));
  assert.ok(r.todo.join('；').includes('需要你运行'));
});

test('否定句：I did not run / did not modify → 不误报', () => {
  const r = translate("I did not run the tests, and I didn't modify any files.");
  assert.strictEqual(r.commands.length, 0);
  assert.ok(!r.actions.includes('测试'));
  assert.ok(!r.actions.includes('修改'));
  assert.strictEqual(r.status, 'none');
});

test('命令四分类分类器单独验证', () => {
  assert.strictEqual(classifyCommand('npm install', 'I ran npm install and it worked'), 'executed');
  assert.strictEqual(classifyCommand('npm test', 'Please run npm test to verify'), 'suggested');
  assert.strictEqual(classifyCommand('npm install', 'the npm install command is common'), 'mentioned');
  assert.strictEqual(classifyCommand('rm -rf cache', 'you might rm -rf cache if needed'), 'unknown');
  assert.strictEqual(classifyCommand('npm test', "I did not run npm test"), 'unknown'); // 否定→无法判断
});

test('纯解释：没改文件没跑命令 → none，且四块齐全', () => {
  const { translate, renderBlocks } = require('./announcer-translator.js');
  const r = translate('Great question! Here is how React state works: when you call setState, React schedules a re-render...');
  assert.strictEqual(r.status, 'none');
  const out = renderBlocks(r);
  assert.ok(out.includes('完成状态'));
  assert.ok(out.includes('改了什么'));
  assert.ok(out.includes('验证结果'));
  assert.ok(out.includes('你要做什么'));
});
