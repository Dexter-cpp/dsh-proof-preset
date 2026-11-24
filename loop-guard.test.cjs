'use strict';

/**
 * loop-guard 单元测试：不需要 DSH 进程，直接驱动插件注册的 waterfall 监听器。
 * 运行：node --test loop-guard.test.cjs
 *
 * 1.4.0 覆盖重点：
 *   - 成功调用**永不硬拦**（1.3.1 的核心缺陷）
 *   - 只有同工具 + 同参数 + 同失败结果才进入硬拦截
 *   - 签名/输出哈希无前缀截断；非文本输出参与比较；streak 按工具隔离
 *   - BigInt / 循环引用 / 抛错访问器不崩、不静默失效
 *   - 假设账本状态机与预算；方向工具向后兼容
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('./loop-guard.cjs');
const bus = require('./state-bus.cjs');
const ledger = require('./ledger.cjs');

const {
  DENIAL_CODE, DIRECTIONS_TOOL, HYPOTHESES_TOOL, STATS_TOOL,
} = guard._internals;

/** 假宿主：createRequire(hostManifest) 后能解析 @deepseek-ai/dsh-llm 与 dsh-tools。 */
function makeHostManifest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-guard-host-'));
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

function makeContext() {
  const registered = new Map();
  const tools = [];
  return {
    tools: { register(spec) { tools.push(spec); } },
    tool(name) { return tools.find(item => item.name === name); },
    on(event, listener) {
      const list = registered.get(event) ?? [];
      list.push(listener);
      registered.set(event, list);
      return () => {};
    },
    async dispatch(event, payload, terminal = async () => ({ kind: 'allow' })) {
      const list = registered.get(event) ?? [];
      let index = 0;
      const run = async () => {
        if (index >= list.length) return terminal(payload);
        const listener = list[index++];
        return listener(payload, run);
      };
      return run();
    },
    async emitResult(exec, value) {
      for (const listener of registered.get('tools/result') ?? []) await listener(exec, value);
    },
    async emitDisposed(payload) {
      for (const listener of registered.get('agent/disposed') ?? []) await listener(payload);
    },
  };
}

const agent = { id: 'session-test' };
const call = (ctx, name, args, callId) => ctx.dispatch('tools/pre-execute', {
  name, arguments: args, agent, callId,
});
const result = (ctx, name, args, text, isError = false) => ctx.emitResult({
  name, arguments: args, agent, callId: 'r-' + Math.random(),
}, {
  isError,
  content: [{ type: 'text', text }],
  error: isError ? { message: text } : undefined,
});
const step = (ctx, turn = 1) => ctx.dispatch('agent/pre-step', {
  agent, turn, step: 2, signal: { aborted: false },
}, async () => ({ kind: 'enter', messages: [] }));

const FAIL_ARGS = { command: 'node -e "process.exit(7)"' };
const FAIL_TEXT = 'exit code 7';

async function repeatCall(ctx, times, name = 'pwsh', args = FAIL_ARGS, text = FAIL_TEXT, isError = true) {
  for (let index = 1; index <= times; index += 1) {
    const decision = await call(ctx, name, args, 'c' + index);
    if (decision.kind === 'deny') return index;
    await result(ctx, name, args, text, isError);
  }
  return times + 1;
}

const start = (options = {}) => {
  bus.reset();
  ledger.reset();
  const ctx = makeContext();
  guard.apply(ctx, { threshold: 3, hostManifest: HOST_MANIFEST, ...options });
  return ctx;
};

// ── P0：成功调用不得硬拦 ───────────────────────────────────────────────────

test('三次成功的相同读取后，第 4 次仍然放行（不得误判为失败）', async () => {
  const ctx = start();
  for (let index = 1; index <= 3; index += 1) {
    assert.equal((await call(ctx, 'read', { path: 'README.md' }, 's' + index)).kind, 'allow');
    await result(ctx, 'read', { path: 'README.md' }, 'file content: hello world', false);
  }
  const fourth = await call(ctx, 'read', { path: 'README.md' }, 's4');
  assert.equal(fourth.kind, 'allow');
});

test('成功调用连续 6 次也不产生硬拦截，且不注入“相同失败”提示', async () => {
  const ctx = start({ threshold: 2 });
  for (let index = 1; index <= 6; index += 1) {
    assert.equal((await call(ctx, 'read', { path: 'a.txt' }, 'k' + index)).kind, 'allow');
    await result(ctx, 'read', { path: 'a.txt' }, 'same', false);
  }
  const injected = await step(ctx, 1);
  const texts = (injected.messages ?? []).map(message => message.content[0].text).join('\n');
  assert.doesNotMatch(texts, /同一失败结果/);
});

test('三次相同失败后第 4 次被拒绝，拒绝码与换路指令同时出现', async () => {
  const ctx = start();
  assert.equal(await repeatCall(ctx, 3), 4);
  const blocked = await call(ctx, 'pwsh', FAIL_ARGS, 'c4');
  assert.equal(blocked.kind, 'deny');
  assert.equal(blocked.info.code, DENIAL_CODE);
  assert.match(blocked.reason, /已连续 3 次得到相同失败/);
  assert.match(blocked.reason, /请换一个可检验的新策略，并先说明新假设与判定标准/);
  const injected = await step(ctx, 1);
  assert.match(injected.messages[0].content[0].text, /判定标准/);
});

test('失败后成功一次，失败链立刻归零（同一参数不再被拦）', async () => {
  const ctx = start({ threshold: 2 });
  await repeatCall(ctx, 2);
  await call(ctx, 'pwsh', FAIL_ARGS, 'x1');
  await result(ctx, 'pwsh', FAIL_ARGS, 'ok now', false);
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'x2')).kind, 'allow');
});

test('denyOn:"never" 时只提示不拦截', async () => {
  const ctx = start({ threshold: 2, denyOn: 'never' });
  assert.equal(await repeatCall(ctx, 4), 5);
  const fifth = await call(ctx, 'pwsh', FAIL_ARGS, 'c5');
  assert.equal(fifth.kind, 'allow');
});

test('enabled:false 时完全不干预', async () => {
  const ctx = start({ threshold: 2, enabled: false });
  assert.equal(await repeatCall(ctx, 4), 5);
});

// ── 签名与哈希正确性 ───────────────────────────────────────────────────────

test('超长参数只有尾部不同：签名必须不同（无 8 KB 前缀碰撞）', () => {
  const head = 'A'.repeat(9000);
  const a = guard._internals.signature('write', { path: 'a.txt', content: head + 'TAIL-ONE' });
  const b = guard._internals.signature('write', { path: 'a.txt', content: head + 'TAIL-TWO' });
  assert.notEqual(a, b);
});

test('超长输出只有尾部不同：输出 hash 必须不同', () => {
  const head = 'x'.repeat(200000);
  const a = guard._internals.outputKey({ isError: false, content: [{ type: 'text', text: head + 'A' }] });
  const b = guard._internals.outputKey({ isError: false, content: [{ type: 'text', text: head + 'B' }] });
  assert.notEqual(a, b);
});

test('两张不同图片的输出 hash 不同（非文本内容参与比较）', () => {
  const image = data => ({ isError: false, content: [{ type: 'image', source: { data } }] });
  assert.notEqual(guard._internals.outputKey(image('AAAA')), guard._internals.outputKey(image('BBBB')));
  assert.equal(guard._internals.hasOutput(image('AAAA')), true);
});

test('成功与失败同文本、不同错误码都要区分', () => {
  const text = [{ type: 'text', text: 'boom' }];
  const ok = guard._internals.outputKey({ isError: false, content: text });
  const bad = guard._internals.outputKey({ isError: true, content: text, error: { message: 'boom' } });
  assert.notEqual(ok, bad);
  const e1 = guard._internals.outputKey({ isError: true, content: text, error: { code: 'E1' } });
  const e2 = guard._internals.outputKey({ isError: true, content: text, error: { code: 'E2' } });
  assert.notEqual(e1, e2);
});

test('对象键序不影响签名；顶层展示字段被忽略', () => {
  const { signature } = guard._internals;
  assert.equal(signature('x', { a: { y: 1, x: 2 } }), signature('x', { a: { x: 2, y: 1 } }));
  assert.equal(signature('pwsh', { command: 'ls', description: 'a' }), signature('pwsh', { command: 'ls', description: 'b' }));
  for (const field of ['title', 'description', 'label', 'summary']) {
    assert.notEqual(signature('update_issue', { [field]: 'a' }), signature('update_issue', { [field]: 'b' }));
  }
});

test('BigInt / 循环引用 / 抛错访问器都不会让守卫崩溃，且签名稳定', async () => {
  const ctx = start();
  const { signature } = guard._internals;
  assert.equal(typeof signature('x', { n: 10n }), 'string');
  const circular = { name: 'c' };
  circular.self = circular;
  assert.equal(signature('x', circular), signature('x', circular));

  const exploding = { get command() { throw new Error('boom-from-test'); } };
  const decision = await call(ctx, 'pwsh', exploding, 'boom1');
  assert.equal(decision.kind, 'allow');
  assert.ok(guard._internals.logs.some(line => /pre-execute 异常/.test(line)) === false, '不应走到外层异常兜底');
});

// ── streak 隔离与软提示 ────────────────────────────────────────────────────

test('不同工具返回相同输出不合并 streak（不得误报“连续相同输出”）', async () => {
  const ctx = start({ threshold: 3 });
  for (const [name, args] of [['read', { path: 'a' }], ['grep', { pattern: 'b' }], ['bash', { command: 'c' }]]) {
    await call(ctx, name, args, 'm' + name);
    await result(ctx, name, args, 'ok', false);
  }
  const injected = await step(ctx, 1);
  assert.equal((injected.messages ?? []).length, 0);
});

test('同一工具、参数不同但输出连续相同：只注入一次软提示，不拒绝', async () => {
  const ctx = start({ threshold: 3, outputStreakThreshold: 3 });
  for (let index = 1; index <= 3; index += 1) {
    const args = { command: 'echo probe-' + index };
    assert.equal((await call(ctx, 'pwsh', args, 'o' + index)).kind, 'allow');
    await result(ctx, 'pwsh', args, 'no matches found', false);
  }
  const injected = await step(ctx, 1);
  assert.equal(injected.messages.length, 1);
  assert.match(injected.messages[0].content[0].text, /连续 3 次得到相同输出/);
  assert.match(injected.messages[0].content[0].text, /换一个能改变输出的检查/);
});

test('成功但没有任何内容的写入不参与 streak（连续 5 次不提示）', async () => {
  const ctx = start({ threshold: 3, outputStreakThreshold: 2 });
  for (let index = 1; index <= 5; index += 1) {
    const args = { path: 'f' + index, content: 'v' + index };
    assert.equal((await call(ctx, 'write', args, 'w' + index)).kind, 'allow');
    await ctx.emitResult({ name: 'write', arguments: args, agent }, { isError: false, content: [] });
  }
  const injected = await step(ctx, 1);
  assert.equal((injected.messages ?? []).length, 0);
});

test('同一轮通知数量不超过 maxNoticesPerTurn', async () => {
  const ctx = start({ threshold: 2, outputStreakThreshold: 2, maxNoticesPerTurn: 1 });
  await repeatCall(ctx, 2);
  for (let index = 1; index <= 2; index += 1) {
    const args = { command: 'echo ' + index };
    await call(ctx, 'pwsh', args, 'n' + index);
    await result(ctx, 'pwsh', args, 'same-output', false);
  }
  const injected = await step(ctx, 1);
  assert.ok((injected.messages ?? []).length <= 1);
});

// ── 会话隔离、拒绝恢复、配置 ────────────────────────────────────────────────

test('会话 A 的失败链不影响会话 B', async () => {
  const ctx = start({ threshold: 2 });
  const other = { id: 'session-other' };
  await repeatCall(ctx, 2);
  assert.equal((await ctx.dispatch('tools/pre-execute', { name: 'pwsh', arguments: FAIL_ARGS, agent: other }, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c3')).kind, 'deny');
});

test('连续两次撞上拦截后结束本轮；同一轮只拒绝一次，下一轮恢复', async () => {
  const ctx = start({ threshold: 2 });
  await step(ctx, 1);
  await repeatCall(ctx, 2);
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c3')).kind, 'deny');
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c4')).kind, 'deny');
  assert.equal((await step(ctx, 1)).kind, 'reject');
  assert.notEqual((await step(ctx, 1)).kind, 'reject');
  assert.notEqual((await step(ctx, 2)).kind, 'reject');
});

test('threshold 超上限被夹取为 10 并告警', async () => {
  guard._internals.logs.length = 0;
  const ctx = start({ threshold: 100 });
  assert.ok(guard._internals.logs.some(line => /夹取为 10/.test(line)));
  assert.equal(await repeatCall(ctx, 9), 10);
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c10')).kind, 'allow');
  await result(ctx, 'pwsh', FAIL_ARGS, FAIL_TEXT, true);
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c11')).kind, 'deny');
});

test('非法布尔/枚举配置回退默认值并告警', async () => {
  guard._internals.logs.length = 0;
  const ctx = start({ enabled: 'maybe', denyOn: 'always' });
  assert.ok(guard._internals.logs.some(line => /enabled/.test(line)));
  assert.ok(guard._internals.logs.some(line => /denyOn/.test(line)));
  assert.equal(await repeatCall(ctx, 3), 4);
});

test('记账工具不参与相似计数', async () => {
  const ctx = start();
  for (let index = 1; index <= 6; index += 1) {
    assert.equal((await call(ctx, guard._internals.CHECKPOINT_TOOL, { action: 'read' }, 'k' + index)).kind, 'allow');
    assert.equal((await call(ctx, DIRECTIONS_TOOL, { action: 'read' }, 'm' + index)).kind, 'allow');
    assert.equal((await call(ctx, HYPOTHESES_TOOL, { action: 'read' }, 'h' + index)).kind, 'allow');
  }
});

test('缺少 hostManifest 时仍能拦截，注入退化为纯文本 user 消息', async () => {
  const ctx = makeContext();
  bus.reset();
  await guard.apply(ctx, { threshold: 2 });
  await step(ctx, 1);
  await repeatCall(ctx, 2);
  const blocked = await call(ctx, 'pwsh', FAIL_ARGS, 'c3');
  assert.equal(blocked.kind, 'deny');
  const injected = await step(ctx, 1);
  assert.equal(injected.messages[0].role, 'user');
});

// ── 停滞与目标 ─────────────────────────────────────────────────────────────

test('同一用户轮连续两个步骤只产生重复观察时才提示停滞', async () => {
  const ctx = start({ stallRounds: 2, outputStreakThreshold: 10 });
  for (const turn of [1, 2, 3]) assert.equal((await step(ctx, turn)).messages.length, 0);
  for (let i = 0; i < 2; i++) {
    await result(ctx, 'read', { path: 'a' }, 'same');
    assert.equal((await step(ctx, 3)).messages.length, 0);
  }
  await result(ctx, 'read', { path: 'a' }, 'same');
  const second = await step(ctx, 3);
  assert.equal(second.messages.length, 1);
  assert.match(second.messages[0].content[0].text, /连续 2 轮没有新证据/);
  assert.match(second.messages[0].content[0].text, /当前假设/);
});

test('相同参数出现不同失败时重新计数，包含只有结构化错误的情况', async () => {
  const ctx = start({ threshold: 2 });
  for (const message of ['first', 'second', 'third', 'third']) {
    assert.equal((await call(ctx, 'check', {}, 'c')).kind, 'allow');
    await ctx.emitResult({ agent, name: 'check', arguments: {} }, { isError: true, error: { code: 'E', message }, content: [] });
  }
  assert.equal((await call(ctx, 'check', {}, 'end')).info.code, DENIAL_CODE);
});

test('交替失败只拒绝预期的下一操作，守卫自身的拒绝不计入失败历史', async () => {
  const ctx = start({ threshold: 3 });
  await step(ctx);
  for (const path of ['a', 'b', 'a', 'b', 'a', 'b']) {
    assert.equal((await call(ctx, 'check', { path }, path)).kind, 'allow');
    await result(ctx, 'check', { path }, 'failed ' + path, true);
  }
  assert.equal((await call(ctx, 'check', { path: 'c' }, 'fresh')).kind, 'allow');
  const denied = await call(ctx, 'check', { path: 'a' }, 'loop');
  assert.equal(denied.info.code, 'REPEATED_FAILURE_CYCLE');
  await ctx.emitResult({ agent, name: 'check', arguments: { path: 'a' } }, { isError: true, error: { info: denied.info } });
  assert.equal((await call(ctx, 'check', { path: 'a' }, 'again')).kind, 'deny');
  assert.equal((await step(ctx)).kind, 'reject');
  await step(ctx, 2);
  assert.equal((await call(ctx, 'check', { path: 'a' }, 'new-turn')).kind, 'allow');
});

test('交替序列中报错改变或执行成功不会触发循环拦截', async () => {
  for (const changed of ['different failure', 'success']) {
    const ctx = start({ threshold: 2 });
    for (const [path, msg] of [['a', 'errA'], ['b','errB'], ['a',changed], ['b','errB']]) {
      await result(ctx, 'check', { path }, msg, msg !== 'success');
    }
    assert.equal((await call(ctx, 'check', { path: 'a' }, 'next')).kind, 'allow');
  }
});

test('只提示模式保留 A/B 反馈，关闭守卫时始终静默', async () => {
  for (const enabled of [true, false]) {
    const ctx = start({ threshold: 2, enabled, denyOn: 'never', selfCheckEvery: enabled ? 0 : 1 });
    await step(ctx);
    for (const path of ['a','b','a','b']) await result(ctx, 'read', { path }, 'missing', true);
    assert.equal((await call(ctx, 'read', { path: 'a' }, 'next')).kind, 'allow');
    const notes = (await step(ctx)).messages;
    assert.equal(notes.length, enabled ? 1 : 0);
    if (enabled) assert.match(notes[0].content[0].text, /交替失败/);
    else assert.equal((await step(ctx, 2)).messages.length, 0);
  }
});

test('提示配额跨同一用户轮的多个步骤累计，新用户轮恢复配额', async () => {
  const ctx = start({ maxNoticesPerTurn: 1, outputStreakThreshold: 2 });
  await step(ctx);
  async function repeatedOutput(name, turn) {
    await result(ctx, name, {}, 'steady');
    await result(ctx, name, {}, 'steady');
    return (await step(ctx, turn)).messages.length;
  }
  assert.equal(await repeatedOutput('first', 1), 1);
  assert.equal(await repeatedOutput('second', 1), 0);
  await step(ctx, 2);
  assert.equal(await repeatedOutput('second', 2), 1);
});

test('同 revision 更换目标也清空旧方向和失败链', async () => {
  const ctx = start({ threshold: 2 });
  bus.noteGoal(agent.id, { id: 'old', revision: 1 });
  await step(ctx);
  await ctx.tool(DIRECTIONS_TOOL).execute({ action: 'set', items: ['旧方向'] }, { agent });
  await repeatCall(ctx, 2);
  bus.noteGoal(agent.id, { id: 'new', revision: 1 });
  const notes = (await step(ctx)).messages.map(m => m.content[0].text).join('');
  assert.match(notes, /目标版本已变化/);
  assert.doesNotMatch(notes, /1\. 旧方向/);
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'new')).kind, 'allow');
  assert.match(await ctx.tool(DIRECTIONS_TOOL).execute({ action: 'read' }, { agent }), /没有记录方向/);
});

test('创建、删除证据与改写已判定命题都遵守相同证据约束', async () => {
  const ctx = start();
  const execute = args => ctx.tool(HYPOTHESES_TOOL).execute(args, { agent });
  const base = { action: 'set', id: 'H1', statement: '命题', status: 'supported' };
  await assert.rejects(execute(base), /非自证/);
  await assert.rejects(execute({ ...base, evidence: [{ source: '测试脚本' }] }), /观察结果/);
  const evidence = [{ kind: 'test', source: 'node check.cjs', result: 'pass' }];
  await execute({ ...base, evidence });
  const seq = bus.snapshot(agent.id).evidenceSeq;
  await execute({ action: 'update', id: 'H1', evidence });
  assert.equal(bus.snapshot(agent.id).evidenceSeq, seq);
  await assert.rejects(execute({ action: 'update', id: 'H1', evidence: [] }), /非自证/);
  await assert.rejects(execute({ action: 'update', id: 'H1', statement: '另一个命题' }), /supersedes/);
  assert.equal(ledger.get(agent.id, 'H1').evidence.length, 1);
});

test('记录新证据会解除停滞并计入 recovered', async () => {
  const ctx = start({ stallRounds: 2 });
  await step(ctx, 1);
  bus.noteEvidence('session-test', { kind: 'hypothesis' });
  const second = await step(ctx, 2);
  assert.equal((second.messages ?? []).length, 0);
  const stats = JSON.parse(await ctx.tool(STATS_TOOL).execute({ action: 'read' }, { agent }));
  assert.ok(stats.recovered >= 1);
});

test('目标版本变化：旧假设归档并注入目标变更提示', async () => {
  const ctx = start({ stallRounds: 9 });
  bus.noteGoal('session-test', { id: 'g1', revision: 1 });
  await step(ctx, 1);
  const hypotheses = ctx.tool(HYPOTHESES_TOOL);
  await hypotheses.execute({ action: 'set', statement: '贪心即可', axis: 'algorithm' }, { agent });
  bus.noteGoal('session-test', { id: 'g1', revision: 2 });
  const second = await step(ctx, 2);
  const text = (second.messages ?? []).map(message => message.content[0].text).join('\n');
  assert.match(text, /目标版本已变化/);
  const items = ledger.list('session-test', { includeArchived: true });
  assert.ok(items.length >= 1);
  assert.ok(items.every(item => item.archived), '目标变更后旧假设必须全部归档');
});

// ── 方向工具向后兼容 ───────────────────────────────────────────────────────

test('方向工具保持 1.3.1 的参数、文案与上限', async () => {
  const ctx = start();
  const tool = ctx.tool(DIRECTIONS_TOOL);
  assert.ok(tool, '方向记录工具应已注册');
  assert.match(await tool.execute({ action: 'set', items: ['换判据：用 checker', '反向构造'] }, { agent }), /已记录 2 个方向/);
  assert.match(await tool.execute({ action: 'read' }, { agent }), /checker/);
  await assert.rejects(() => tool.execute({ action: 'set', items: ['1', '2', '3', '4'] }, { agent }), /最多记录 3 个方向/);
  await assert.rejects(() => tool.execute({ action: 'set', items: ['y'.repeat(201)] }, { agent }), /最多 200 字符/);
  assert.match(await tool.execute({ action: 'clear' }, { agent }), /已清除/);
  assert.equal(await tool.execute({ action: 'read' }, { agent }), '当前没有记录方向。');
});

// ── 假设账本 ───────────────────────────────────────────────────────────────

test('假设账本：supported 必须有有效且非自证的证据', async () => {
  const ctx = start();
  const tool = ctx.tool(HYPOTHESES_TOOL);
  await tool.execute({ action: 'set', statement: 'H 成立', id: 'H1' }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H1', status: 'supported' }, { agent }), /至少一条有效且非自证的证据/);
  await assert.rejects(() => tool.execute({
    action: 'update', id: 'H1', status: 'supported',
    evidence: [{ kind: 'self', source: '自检', result: '看起来对' }],
  }, { agent }), /非自证/);
  const ok = await tool.execute({
    action: 'update', id: 'H1', status: 'supported',
    evidence: [{ kind: 'checker', source: 'chk.cpp', result: '200 组通过' }],
  }, { agent });
  assert.match(ok, /supported/);
});

test('假设账本：falsified 需要反例证据，且是终态', async () => {
  const ctx = start();
  const tool = ctx.tool(HYPOTHESES_TOOL);
  await tool.execute({ action: 'set', statement: '按右端点排序', id: 'H2' }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H2', status: 'falsified' }, { agent }), /反例/);
  await tool.execute({
    action: 'update', id: 'H2', status: 'falsified',
    evidence: [{ kind: 'test', source: 'stress seed 12345', result: '得到 4，期望 5' }],
  }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H2', status: 'testing' }, { agent }), /终态/);
  await assert.rejects(() => tool.execute({ action: 'reopen', id: 'H2' }, { agent }), /不能重开/);
});

test('假设账本：非法迁移与超限都被拒绝且不改变原状态', async () => {
  const ctx = start();
  const tool = ctx.tool(HYPOTHESES_TOOL);
  await tool.execute({ action: 'set', statement: '初始命题', id: 'H3' }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H3', status: 'supported' }, { agent }), /至少一条有效且非自证的证据/);
  await tool.execute({ action: 'update', id: 'H3', status: 'blocked' }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H3', status: 'supported' }, { agent }), /不允许 blocked → supported/);
  const view = await tool.execute({ action: 'read' }, { agent });
  assert.match(view, /H3 \[blocked\]/);
  for (let index = 4; index <= 23; index += 1) {
    try {
      await tool.execute({ action: 'set', statement: '命题 ' + index }, { agent });
    } catch (error) {
      assert.match(String(error.message), /最多 20 条/);
      return;
    }
  }
  assert.fail('第 21 条应被拒绝');
});

test('假设账本：高风险假设进入 testing 前必须写 nextCheck', async () => {
  const ctx = start();
  const tool = ctx.tool(HYPOTHESES_TOOL);
  await tool.execute({ action: 'set', statement: '高风险命题', id: 'H9', risk: 'high' }, { agent });
  await assert.rejects(() => tool.execute({ action: 'update', id: 'H9', status: 'testing' }, { agent }), /nextCheck/);
  const ok = await tool.execute({ action: 'update', id: 'H9', status: 'testing', nextCheck: 'n≤6 穷举 200 组' }, { agent });
  assert.match(ok, /testing/);
});

test('同义命题被证伪后新建会给出提示（不改名逃避）', async () => {
  const ctx = start();
  const tool = ctx.tool(HYPOTHESES_TOOL);
  await tool.execute({ action: 'set', statement: '贪心 按右端点 排序', id: 'H1' }, { agent });
  await tool.execute({
    action: 'update', id: 'H1', status: 'falsified',
    evidence: [{ kind: 'test', source: 'seed 1', result: '反例' }],
  }, { agent });
  const again = await tool.execute({ action: 'set', statement: '贪心按右端点排序', id: 'H5' }, { agent });
  assert.match(again, /同义假设被证伪/);
});

test('统计工具返回观察/软提示/硬拦截/恢复计数', async () => {
  const ctx = start({ threshold: 2 });
  await repeatCall(ctx, 2);
  await call(ctx, 'pwsh', FAIL_ARGS, 'c3');
  const stats = JSON.parse(await ctx.tool(STATS_TOOL).execute({ action: 'read' }, { agent }));
  assert.ok(stats.observed >= 3);
  assert.equal(stats.denied, 1);
  assert.ok(stats.byTool.pwsh.calls >= 3);
});

test('agent/disposed 清理状态，不泄漏到后续会话', async () => {
  const ctx = start({ threshold: 2 });
  await repeatCall(ctx, 2);
  await ctx.emitDisposed({ agent });
  assert.equal((await call(ctx, 'pwsh', FAIL_ARGS, 'c3')).kind, 'allow');
});
