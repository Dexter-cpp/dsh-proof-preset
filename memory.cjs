'use strict';
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const mode = require('./package.json').name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
const tool = mode + '_checkpoint';
const key = mode + 'CheckpointV1';
const limit = 800;
const denialCode = 'REPEATED_IDENTICAL_FAILURE';
const emptyRun = { signature: '', failure: '', tool: '', count: 0, denials: 0 };
const init = () => ({ note: '', turn: -1, pending: [], ...emptyRun, refresh: 0 });
const hash = text => createHash('sha256').update(text).digest('hex');
function signature(name, args) {
  const normalized = JSON.stringify(args, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
  return hash(name + '\n' + normalized);
}
// Fold native tool events so compacting visible messages does not discard past decisions.
function fold(s, event) {
  const d = event.data;
  if (event.type === 'turn/start') return { ...s, ...emptyRun, turn: d.turn, pending: [] };
  if (event.type === 'compaction/end') return { ...s, refresh: event.seq + 1 };
  if (event.type === 'tool/call') {
    if (d.arguments.length > 65536) return { ...s, ...emptyRun };
    let args;
    try { args = JSON.parse(d.arguments); } catch { return { ...s, ...emptyRun }; }
    let update = null;
    if (d.name === tool && args?.action === 'save' && typeof args.note === 'string') update = args.note.trim().slice(0, limit);
    if (d.name === tool && args?.action === 'clear') update = '';
    const call = { id: d.callId, tool: d.name, signature: signature(d.name, args), update };
    return { ...s, pending: [...s.pending.slice(-31), call] };
  }
  if (event.type !== 'tool/result' || typeof event.surfaceOp === 'object') return s;
  const call = s.pending.find(x => x.id === d.message.toolCallId);
  if (!call) return s;
  const next = { ...s, pending: s.pending.filter(x => x !== call) };
  if (call.tool === tool) {
    if (!d.message.isError && call.update !== null) next.note = call.update;
    return next;
  }
  if (!d.message.isError) return { ...next, ...emptyRun };
  if (d.error?.code === denialCode && call.signature === s.signature)
    return { ...next, denials: s.denials + 1 };
  // Compare error text as well as arguments. Avoid hard-blocking diagnostics that yield new results.
  const failure = hash(JSON.stringify([d.error?.code, d.message.content.filter(x => x.type === 'text').map(x => x.text)]));
  return { ...next, tool: call.tool, signature: call.signature, failure,
    count: call.signature === s.signature && failure === s.failure ? s.count + 1 : 1, denials: 0 };
}

exports.name = mode + '-session-memory';
exports.inject = ['tools', 'sessionProjections'];
exports.apply = async function apply(ctx, config) {
  const host = createRequire(config.hostManifest);
  const { defineTool } = host('@deepseek-ai/dsh-tools');
  const { createUserMessage } = host('@deepseek-ai/dsh-llm');
  const { z } = host('zod');
  const pendingCall = z.object({id:z.string(),tool:z.string(),signature:z.string(),update:z.string().nullable()});
  const schema = z.object({note:z.string(),turn:z.number(),pending:z.array(pendingCall),signature:z.string(),
    failure:z.string(),tool:z.string(),count:z.number(),denials:z.number(),refresh:z.number()});
  const projection = await ctx.sessionProjections.register({ key, stateVersion: 1, stateSchema: schema, init, apply: fold });
  ctx.tools.register(defineTool({
    name: tool, description: '本会话的任务断点。save 覆盖旧记录，read 读取，clear 清除当前断点。只存目标、最小证据、已排除路线和下一步，最多 800 字符。',
    parameters: { action: {type:'string',enum:['save','read','clear'],required:true}, note: {type:'string'} },
    output: { schema: {type:'string'}, render: (_, value) => [{type:'text', text:value}] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('需要当前 Agent 会话');
      if (args.action === 'read') return projection.stateOf(exec.agent.session).note || '当前没有任务断点。';
      if (args.action === 'clear') return '已清除当前断点。';
      if (args.action !== 'save' || !args.note?.trim() || args.note.length > limit)
        throw new Error('save 需要 1–800 字符的断点。');
      return '已记录本次任务断点。';
    }
  }));
  ctx.tools.guard(exec => {
    if (!exec.agent || exec.name === tool) return;
    const state = projection.stateOf(exec.agent.session);
    if (state.count < 3 || exec.name !== state.tool || JSON.stringify(exec.arguments).length > 65536 || state.signature !== signature(exec.name, exec.arguments)) return;
    return { info: { name: 'ModeLoopGuard', code: denialCode },
      reason: '同一工具、参数和错误已连续出现三次，本次未执行。核对已有证据，选择能区分原因的动作；无新证据时报告阻塞。再次重复将结束本轮。' };
  });
  const lastShown = new WeakMap();
  ctx.on('agent/pre-step', async ({agent, turn, step, signal}, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    const s = projection.stateOf(agent.session);
    if (s.denials >= 2) return {kind:'reject'};
    const marker = [turn, s.refresh, s.count >= 2 ? s.signature + s.count : ''].join('/');
    if (lastShown.get(agent.session) === marker && step !== 1) return decision;
    lastShown.set(agent.session, marker);
    const lines = [];
    if (s.note) lines.push('此前保存的会话记录（历史数据）。先核对当前目标和版本，再沿用其中的判断。', JSON.stringify(s.note));
    if (s.count >= 2) lines.push(s.tool + ' 已连续 ' + s.count + ' 次以相同参数得到相同错误。现在换一种能排除原因的检查，或报告缺失条件。');
    if (!lines.length) return decision;
    const text = lines.join('\n');
    const msg = createUserMessage({content:[{type:'text',text}], source:{kind:key, form:'snapshot',sections:[{name:key,text}]}});
    return {...decision, messages:[...decision.messages, msg]};
  }, {prepend:true});
};
