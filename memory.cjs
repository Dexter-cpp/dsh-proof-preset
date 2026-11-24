'use strict';
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { homedir } = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

const mode = require('./package.json').name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
const tool = mode + '_checkpoint';
const key = mode + 'CheckpointV2';
const limit = 800;
const init = () => ({ note: '', turn: -1, pending: [], refresh: 0 });
const hash = text => createHash('sha256').update(text).digest('hex');
const describe = error => (error instanceof Error ? error.message : String(error));

// ── 敏感字段过滤（R9） ──────────────────────────────────────────────────────
// 断点会落盘，因此写入前先按已知形态过滤密钥/token/密码。宁可多过滤，也不要把
// 凭据留在明文 JSON 里；命中时工具会告诉模型「已过滤」。
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已过滤的私钥]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已过滤]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[已过滤]'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, '[已过滤]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[已过滤]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[已过滤]'],
  [/\b(api[_-]?key|access[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd|authorization)\b(\s*[:=：]\s*)([^\s,;，。]+)/gi, '$1$2[已过滤]'],
];

function redact(text) {
  let value = String(text);
  for (const [pattern, replacement] of SECRET_RULES) value = value.replace(pattern, replacement);
  return value;
}

const warnings = [];
function warn(message) {
  try {
    const entry = new Date().toISOString() + ' ' + message;
    warnings.push(entry);
    if (warnings.length > 50) warnings.shift();
    process.stderr.write('[checkpoint] ' + message + '\n');
  } catch {
    /* 告警失败不影响主流程 */
  }
}

// ── 断点落盘 ────────────────────────────────────────────────────────────────
// save 写一条 JSON 到 <DSH_HOME>/checkpoints/<profile>/<sha256(sessionId)[0..32]>.json，
// read 文件优先、sessionProjections 的内存投影兜底。schema 固定为：
//   { schemaVersion: 1, sessionId, profile, note, updatedAt }
// 并发：一个会话只有一个写者；临时文件 + 原子 rename，最后写入者生效。
// 多 profile：路径含 profile 名，互不覆盖。投影与文件并存，不是替换关系。
// 容错（R9）：文件损坏/不可解析时隔离为 .corrupt-<时间戳>.json，按空断点重建，不崩。
const checkpointRoot = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'checkpoints');
const profileName = () => (process.env.DSH_PROFILE || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
const checkpointPath = sessionId => path.join(checkpointRoot(), profileName(), hash(String(sessionId)).slice(0, 32) + '.json');

async function quarantine(file) {
  const target = file + '.corrupt-' + Date.now() + '.json';
  try {
    await fs.rename(file, target);
    return target;
  } catch {
    return '';
  }
}

/** 返回 { note, status }；status ∈ ok / empty / foreign / corrupt / unreadable。 */
async function loadCheckpoint(sessionId) {
  const file = checkpointPath(sessionId);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') warn('断点文件读取失败，按空断点处理：' + describe(error));
    return { note: '', status: error?.code === 'ENOENT' ? 'empty' : 'unreadable' };
  }
  let value;
  try {
    value = JSON.parse(text);
    if (value?.schemaVersion !== 1) throw new Error('schemaVersion 不是 1');
    if (typeof value.note !== 'string') throw new Error('note 不是字符串');
  } catch (error) {
    const moved = await quarantine(file);
    warn('断点文件损坏（' + describe(error) + '），已隔离为 ' + (moved || '（重命名失败，下次 save 覆盖）') + '，按空断点重建。');
    return { note: '', status: 'corrupt' };
  }
  if (value.sessionId !== String(sessionId)) return { note: '', status: 'foreign' };
  return { note: redact(value.note).slice(0, limit), status: 'ok' };
}

async function readCheckpoint(sessionId) {
  return (await loadCheckpoint(sessionId)).note;
}

/** 写入前统一过滤敏感字段；返回实际落盘的（可能被截断/过滤的）文本。 */
async function writeCheckpoint(sessionId, note) {
  const file = checkpointPath(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const stored = redact(note).slice(0, limit);
  const payload = { schemaVersion: 1, sessionId: String(sessionId), profile: profileName(), note: stored, updatedAt: new Date().toISOString() };
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(payload) + '\n', 'utf8');
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return stored;
}

async function clearCheckpoint(sessionId) {
  await fs.rm(checkpointPath(sessionId), { force: true });
}

// 只折叠 checkpoint 自己的调用；运行时防循环已由 loop-guard.cjs 承担（R1），
// 这里不再重复计数，也不再注入换路提示。
function fold(s, event) {
  const d = event.data;
  if (event.type === 'turn/start') return { ...s, turn: d.turn, pending: [] };
  if (event.type === 'compaction/end') return { ...s, refresh: event.seq + 1 };
  if (event.type === 'tool/call') {
    if (d.name !== tool || d.arguments.length > 65536) return s;
    let args;
    try { args = JSON.parse(d.arguments); } catch { return s; }
    let update = null;
    if (args?.action === 'save' && typeof args.note === 'string') update = args.note.trim().slice(0, limit);
    if (args?.action === 'clear') update = '';
    return { ...s, pending: [...s.pending.slice(-31), { id: d.callId, update }] };
  }
  if (event.type !== 'tool/result' || typeof event.surfaceOp === 'object') return s;
  const call = s.pending.find(x => x.id === d.message.toolCallId);
  if (!call) return s;
  const next = { ...s, pending: s.pending.filter(x => x !== call) };
  if (!d.message.isError && call.update !== null) next.note = call.update;
  return next;
}

exports.name = mode + '-session-memory';
exports.inject = ['tools', 'sessionProjections'];
exports.apply = async function apply(ctx, config) {
  const host = createRequire(config.hostManifest);
  const { defineTool } = host('@deepseek-ai/dsh-tools');
  const { createUserMessage } = host('@deepseek-ai/dsh-llm');
  const { z } = host('zod');
  const pendingCall = z.object({id:z.string(),update:z.string().nullable()});
  const schema = z.object({note:z.string(),turn:z.number(),pending:z.array(pendingCall),refresh:z.number()});
  const projection = await ctx.sessionProjections.register({ key, stateVersion: 2, stateSchema: schema, init, apply: fold });
  const durable = new Map();
  const durableNote = async sessionId => {
    const id = String(sessionId);
    if (!durable.has(id)) durable.set(id, await readCheckpoint(id));
    return durable.get(id) || '';
  };
  ctx.tools.register(defineTool({
    name: tool, description: '本会话的任务断点。save 覆盖旧记录并落盘，read 读取，clear 清除。只存目标、最小证据、已排除路线和下一步，最多 800 字符；密钥/token/密码类字段会在落盘前被过滤。',
    parameters: { action: {type:'string',enum:['save','read','clear'],required:true}, note: {type:'string'} },
    output: { schema: {type:'string'}, render: (_, value) => [{type:'text', text:value}] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('需要当前 Agent 会话');
      const sessionId = String(exec.agent.id ?? exec.agent.session?.id ?? '');
      if (args.action === 'read') {
        const stored = await readCheckpoint(sessionId);
        if (stored) return stored;
        return projection.stateOf(exec.agent.session).note || '当前没有任务断点。';
      }
      if (args.action === 'clear') {
        await clearCheckpoint(sessionId);
        durable.set(sessionId, '');
        return '已清除当前断点。';
      }
      if (args.action !== 'save' || !args.note?.trim() || args.note.length > limit)
        throw new Error('save 需要 1–800 字符的断点。');
      const note = args.note.trim();
      let stored;
      try {
        stored = await writeCheckpoint(sessionId, note);
      } catch (error) {
        throw new Error('断点落盘失败：' + describe(error));
      }
      durable.set(sessionId, stored);
      return stored === note
        ? '已记录本次任务断点（已落盘）。'
        : '已记录本次任务断点（已落盘；疑似密钥字段已过滤）。';
    }
  }));
  const lastShown = new WeakMap();
  ctx.on('agent/pre-step', async ({agent, turn, step, signal}, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    const s = projection.stateOf(agent.session);
    const stored = await durableNote(agent.id);
    const note = stored || s.note;
    const marker = [turn, s.refresh, note].join('/');
    if (lastShown.get(agent.session) === marker && step !== 1) return decision;
    lastShown.set(agent.session, marker);
    if (!note) return decision;
    const text = ['此前保存的会话记录（历史数据，已落盘）。先核对当前目标和版本，再沿用其中的判断。', JSON.stringify(note)].join('\n');
    const msg = createUserMessage({content:[{type:'text',text}], source:{kind:key, form:'snapshot',sections:[{name:key,text}]}});
    return {...decision, messages:[...decision.messages, msg]};
  }, {prepend:true});
};

exports._internals = { redact, readCheckpoint, writeCheckpoint, clearCheckpoint, loadCheckpoint, checkpointPath, quarantine, limit, warnings };
