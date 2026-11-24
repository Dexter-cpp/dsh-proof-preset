'use strict';

/**
 * memory.cjs 单元测试：断点落盘安全、v1→v2 迁移、注入策略。
 * 运行：node --test memory.test.cjs
 *
 * 只测本仓库自己的实现；跨仓库一致性由 parity.test.cjs 用哈希清单校验，
 * 不再依赖任何相邻目录（1.3.1 的跨目录引用已移除）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('./memory.cjs');
const api = memory._internals;

function useHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'test';
  return home;
}

function makeHostManifest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-host-'));
  const write = (name, source) => {
    const target = path.join(root, 'node_modules', '@deepseek-ai', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(target, 'index.js'), source);
  };
  write('dsh-llm', "exports.createUserMessage = spec => ({ role: 'user', ...spec });\n");
  write('dsh-tools', "exports.defineTool = spec => spec;\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-host', version: '0.0.0' }));
  return path.join(root, 'package.json');
}

const HOST_MANIFEST = makeHostManifest();

test('敏感字段在落盘前被过滤，磁盘与读回都不含明文', async () => {
  useHome();
  const note = [
    '目标：修 add()；api_key: sk-live-abcdef1234567890',
    'password: hunter2',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
    '下一步：跑 node check.js',
  ].join('\n');
  const stored = await api.writeCheckpoint('session-secret', note);
  assert.doesNotMatch(stored, /sk-live-abcdef/);
  assert.doesNotMatch(stored, /hunter2/);
  assert.doesNotMatch(stored, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(stored, /下一步：跑 node check\.js/);
  const raw = fs.readFileSync(api.checkpointPath('session-secret'), 'utf8');
  assert.doesNotMatch(raw, /sk-live-abcdef/);
  assert.doesNotMatch(raw, /hunter2/);
  assert.equal(await api.readCheckpoint('session-secret'), stored);
});

test('结构化字段同样被过滤', async () => {
  useHome();
  await api.writeCheckpoint('session-doc', '正常断点', {
    state: { excluded: ['token: abcdefghijklmnop'], nextAction: 'password: hunter2' },
  });
  const raw = fs.readFileSync(api.checkpointPath('session-doc'), 'utf8');
  assert.doesNotMatch(raw, /abcdefghijklmnop/);
  assert.doesNotMatch(raw, /hunter2/);
});

test('普通断点不被误伤', async () => {
  useHome();
  const note = '目标：让 test3 通过；已排除：编码问题；下一步：跑 test3.js 看 diff';
  assert.equal(await api.writeCheckpoint('session-plain', note), note);
  assert.equal(await api.readCheckpoint('session-plain'), note);
});

test('损坏文件被隔离并按空断点重建，不抛异常', async () => {
  const home = useHome();
  const file = api.checkpointPath('session-broken');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"schemaVersion":2,"note":"半截', 'utf8');

  const loaded = await api.loadCheckpoint('session-broken');
  assert.equal(loaded.status, 'corrupt');
  assert.equal(loaded.note, '');
  const quarantined = fs.readdirSync(path.join(home, 'checkpoints', 'test')).filter(name => name.includes('.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await api.writeCheckpoint('session-broken', '重建后的断点'), '重建后的断点');
  assert.equal(await api.readCheckpoint('session-broken'), '重建后的断点');
});

test('schema 不符 / 会话不符按空断点处理', async () => {
  useHome();
  const file = api.checkpointPath('session-schema');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, sessionId: 'session-schema', note: 'x' }), 'utf8');
  assert.equal((await api.loadCheckpoint('session-schema')).status, 'corrupt');

  const other = api.checkpointPath('session-foreign');
  fs.writeFileSync(other, JSON.stringify({ schemaVersion: 2, sessionId: 'another-session', note: 'x' }), 'utf8');
  const foreign = await api.loadCheckpoint('session-foreign');
  assert.equal(foreign.status, 'foreign');
  assert.equal(foreign.note, '');
  assert.equal(fs.existsSync(other), true, '别的会话的文件不该被隔离');
});

test('v1 断点可读并迁移，写回时升级为 v2', async () => {
  useHome();
  const file = api.checkpointPath('session-v1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, sessionId: 'session-v1', profile: 'test', note: '旧断点', updatedAt: '2026-01-01T00:00:00.000Z',
  }), 'utf8');
  const loaded = await api.loadCheckpoint('session-v1');
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.note, '旧断点');
  assert.equal(loaded.doc.migratedFrom, 1);
  await api.writeCheckpoint('session-v1', '新断点', { taskId: 't1', goalRef: { id: 'g1', revision: 2 }, state: { nextAction: '跑回归' } });
  const upgraded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.goalRef.revision, 2);
  assert.equal(upgraded.state.nextAction, '跑回归');
});

test('writeSchema:1 可写回旧格式（回滚用）', async () => {
  useHome();
  await api.writeCheckpoint('session-legacy', '回滚断点', { state: { nextAction: 'x' } }, { writeSchema: 1 });
  const raw = JSON.parse(fs.readFileSync(api.checkpointPath('session-legacy'), 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.state, undefined);
});

test('超大断点文件被隔离，不读入内存', async () => {
  useHome();
  const file = api.checkpointPath('session-huge');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(api.MAX_FILE_BYTES + 10), 'utf8');
  const loaded = await api.loadCheckpoint('session-huge');
  assert.equal(loaded.status, 'oversize');
  assert.equal(fs.existsSync(file), false);
});

test('state 类型错误判为损坏', async () => {
  useHome();
  const file = api.checkpointPath('session-badstate');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, sessionId: 'session-badstate', note: 'x', state: 'not-an-object' }), 'utf8');
  assert.equal((await api.loadCheckpoint('session-badstate')).status, 'corrupt');
});

test('clear 删除断点文件', async () => {
  useHome();
  await api.writeCheckpoint('session-clear', '待清除');
  assert.equal(fs.existsSync(api.checkpointPath('session-clear')), true);
  await api.clearCheckpoint('session-clear');
  assert.equal(fs.existsSync(api.checkpointPath('session-clear')), false);
  assert.equal(await api.readCheckpoint('session-clear'), '');
});

test('投影 fold 阶段就脱敏（内存态不留明文）', () => {
  const state = { note: '', turn: -1, pending: [], refresh: 0 };
  const afterCall = api.fold(state, {
    type: 'tool/call',
    data: { name: memory.name.replace('-session-memory', '_checkpoint'), callId: 'c1', arguments: JSON.stringify({ action: 'save', note: 'api_key: sk-live-abcdef1234567890' }) },
  });
  const afterResult = api.fold(afterCall, {
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', isError: false } },
  });
  assert.doesNotMatch(afterResult.note, /sk-live-abcdef/);
  assert.match(afterResult.note, /已过滤/);
});

test('注入只在 resume / 里程碑触发，不每轮重复同一段正文', async () => {
  useHome();
  const listeners = new Map();
  const tools = [];
  const ctx = {
    tools: { register(spec) { tools.push(spec); } },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return () => {}; },
  };
  await memory.apply(ctx, { hostManifest: HOST_MANIFEST });
  const checkpoint = tools.find(item => item.name.endsWith('_checkpoint'));
  assert.ok(checkpoint, '断点工具应已注册');

  const agent = { id: 'session-inject' };
  const step = turn => {
    let index = 0;
    const list = listeners.get('agent/pre-step') ?? [];
    const run = async () => (index < list.length
      ? list[index++]({ agent, turn, step: 1, signal: { aborted: false } }, run)
      : { kind: 'enter', messages: [] });
    return run();
  };

  await checkpoint.execute({ action: 'save', note: '目标：修 add；下一步：跑 check.js' }, { agent });
  const first = await step(1);
  assert.equal(first.messages.length, 1, '首次进入会话应注入（resume）');
  assert.match(first.messages[0].content[0].text, /历史数据/);

  const second = await step(2);
  assert.equal(second.messages.length, 0, '正文没变时不得重复注入');

  await checkpoint.execute({ action: 'save', note: '目标：修 add；已排除编码问题；下一步：跑 test3' }, { agent });
  const third = await step(3);
  assert.equal(third.messages.length, 1, '断点更新后应再注入一次（milestone）');
  assert.match(third.messages[0].content[0].text, /已排除编码问题/);
});

test('缺 sessionProjections / zod 时插件仍加载，断点工具可用', async () => {
  useHome();
  const tools = [];
  const ctx = { tools: { register(spec) { tools.push(spec); } }, on() { return () => {}; } };
  await memory.apply(ctx, { hostManifest: HOST_MANIFEST });
  assert.equal(tools.length, 1);
  assert.equal(memory.inject.includes('sessionProjections'), false);
});

test('Cordis 可选服务通过 get 查找；断点在写入成功后同步新增观察和目标', async () => {
  useHome();
  const bus = require('./state-bus.cjs');
  const agent = { id: 'session-bus' };
  const tools = [];
  const ctx = {
    get(name) { assert.equal(name, 'sessionProjections'); return undefined; },
    get sessionProjections() { throw new Error('without inject'); },
    tools: { register(tool) { tools.push(tool); } },
    on() {},
  };
  await memory.apply(ctx, { hostManifest: HOST_MANIFEST });
  const save = fields => tools[0].execute({ action: 'save', note: 'phase', ...fields }, { agent });
  const goalRef = { id: 'g', revision: 1 };
  await save({ goalRef, runs: ['seed 42 passed'] });
  assert.deepEqual(bus.snapshot(agent.id).goalRef, goalRef);
  assert.equal(bus.snapshot(agent.id).evidenceSeq, 1);
  await save({ goalRef, runs: ['seed 42 passed'], nextAction: '再检查' });
  assert.equal(bus.snapshot(agent.id).evidenceSeq, 1);
  await assert.rejects(save({ note: '', goalRef: { id: 'other', revision: 1 } }));
  assert.deepEqual(bus.snapshot(agent.id).goalRef, goalRef);
  await save({ goalRef: { id: 'g', revision: 2 }, counterexamples: ['n=6'] });
  assert.equal(bus.snapshot(agent.id).goalRef.revision, 2);
  assert.equal(bus.snapshot(agent.id).evidenceSeq, 2);
});
