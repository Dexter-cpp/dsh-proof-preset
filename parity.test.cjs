'use strict';

/**
 * 一致性测试：共享运行时文件必须与 runtime-parity.json 的哈希一致。
 * 运行：node --test parity.test.cjs
 *
 * 1.3.1 的 parity 测试要求另一个仓库的目录与它并排，单独 clone 任一仓库都会失败。
 * 1.4.0 改为**哈希清单**：每个仓库自带一份期望哈希，改动共享文件而忘了同步时，
 * 两边都会在本地失败，不需要另一个仓库在场。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = __dirname;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sha = file => createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');

const manifest = JSON.parse(read('runtime-parity.json'));
const pkg = JSON.parse(read('package.json'));
const guard = read('loop-guard.cjs');
const memory = read('memory.cjs');
const patch = read('cordis.patch.yml');

function personaText() {
  const lines = patch.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*-\s+id:\s*persona\s*$/.test(line));
  assert.ok(start >= 0, 'cordis.patch.yml 缺少 persona');
  const collect = key => {
    const at = lines.findIndex((line, index) => index > start && new RegExp('^\\s*' + key + ':\\s*\\|-\\s*$').test(line));
    assert.ok(at > start, 'persona 缺少 ' + key);
    const indent = lines[at].search(/\S/);
    const body = [];
    for (let index = at + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '') { body.push(''); continue; }
      if (line.search(/\S/) <= indent) break;
      body.push(line.trim());
    }
    return body.join('\n');
  };
  return collect('prefix') + '\n' + collect('suffix');
}

test('runtime-parity.json 覆盖全部共享文件且哈希一致', () => {
  assert.equal(manifest.version, pkg.version, '清单版本应与 package.json 一致');
  const files = Object.keys(manifest.files);
  assert.ok(files.length >= 6, '共享文件至少 6 个');
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' 不存在');
    assert.equal(sha(file), manifest.files[file], file + ' 与清单哈希不一致（共享文件被单边修改）');
  }
});

test('package.json 收录新增文件与版本号', () => {
  for (const file of ['state-bus.cjs', 'ledger.cjs', 'loop-guard.cjs', 'memory.cjs', 'runtime-parity.json']) {
    assert.ok(pkg.files.includes(file), 'package.json files 缺少 ' + file);
  }
  assert.equal(pkg.version, '1.4.0');
});

test('测试与评测代码不依赖相邻仓库目录', () => {
  for (const file of ['loop-guard.test.cjs', 'memory.test.cjs', 'parity.test.cjs']) {
    const text = read(file);
    assert.doesNotMatch(text, /\.\.\/(proof|deliberate)-preset/, file + ' 仍引用相邻目录');
    assert.doesNotMatch(text, /dsh-(proof|deliberate)-preset\//, file + ' 仍引用仓库名路径');
  }
});

test('共享实现已移除 8 KB 截断，签名与输出哈希为 v2', () => {
  assert.doesNotMatch(guard, /MAX_HASH_CHARS/, '不得再按 8 KB 截断');
  assert.match(guard, /sig\/v2/);
  assert.match(guard, /out\/v2/);
  assert.match(guard, /function writeCanonical/);
});

test('硬拦截只针对失败重复（成功不得误判）', () => {
  assert.match(guard, /state\.failed/, '拦截条件必须检查上一次是否失败');
  assert.match(guard, /denyOn/, '必须可配置 denyOn');
  assert.match(guard, /repeatFailure/);
});

test('输出 streak 按工具隔离，且覆盖非文本输出', () => {
  assert.match(guard, /state\.streaks\.get\(exec\.name\)/, 'streak 必须按工具取');
  assert.match(guard, /type === 'image'/, '图片块必须参与输出哈希');
  assert.match(guard, /function hasOutput/);
});

test('断点 v2 + v1 迁移 + 投影脱敏 + 注入策略齐全', () => {
  assert.match(memory, /SCHEMA_VERSION = 2/);
  assert.match(memory, /function migrateV1/);
  assert.match(memory, /redact\(args\.note/, 'fold 阶段必须脱敏');
  assert.match(memory, /DEFAULT_INJECT_ON/);
  assert.match(memory, /EPERM/);
});

test('loop-guard 在 session-memory 之前注册，工具组合未新增行', () => {
  const guardAt = patch.search(/^ {10}- id: loop-guard$/m);
  const memoryAt = patch.search(/^ {10}- id: session-memory$/m);
  assert.ok(guardAt > 0 && memoryAt > 0 && guardAt < memoryAt);
  const rows = patch.split(/\r?\n/).map(line => /^ {10}- id:\s*(\S+)\s*$/.exec(line)).filter(Boolean).map(m => m[1]);
  assert.equal(rows[0], 'persona');
  assert.ok(rows.includes('loop-guard') && rows.includes('session-memory'));
  assert.ok(!rows.includes('hypotheses'), '假设账本应注册在 loop-guard 内，不新增插件行');
});

test('persona 覆盖目标/证据/验证/止损/交付五个语义槽位', () => {
  const text = personaText();
  const slots = ['目标', '证据', '验证', '止损', '静态检查与运行验证分开写'];
  const missing = slots.filter(word => !text.includes(word));
  assert.deepEqual(missing, [], '缺少语义槽位：' + missing.join('、'));
  assert.match(text, /_hypotheses/);
  assert.match(text, /_checkpoint/);
});

test('persona 不再强制“反直觉方向”或固定边界清单', () => {
  const text = personaText();
  assert.doesNotMatch(text, /至少一个方向要反直觉/);
  assert.doesNotMatch(text, /逐项勾选/);
  assert.doesNotMatch(text, /与本题无关的写/);
  assert.match(text, /1–3 个不同方向|1–3 个方向/);
});

test('假设账本状态机与预算上限存在', () => {
  const ledger = read('ledger.cjs');
  for (const status of ['untested', 'testing', 'supported', 'falsified', 'blocked']) {
    assert.ok(ledger.includes(status), '缺少状态 ' + status);
  }
  assert.match(ledger, /TRANSITIONS/);
  assert.match(ledger, /maxHypotheses/);
  assert.match(ledger, /falsified 是终态|falsified 不能重开/);
});

test('两个 preset 只引用自己的工具名', () => {
  const text = personaText();
  const mine = pkg.name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
  const other = mine === 'proof' ? 'deliberate' : 'proof';
  assert.match(text, new RegExp(mine + '_hypotheses'));
  assert.doesNotMatch(text, new RegExp(other + '_hypotheses'));
});
