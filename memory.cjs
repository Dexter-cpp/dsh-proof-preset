'use strict';

/**
 * 会话断点：`*_checkpoint` 工具 + 落盘 + 投影兜底 + 有选择的注入。
 *
 * 1.4.0 变更：
 *   - 落盘 schema 升到 v2（保留 v1 读取与迁移），v2 增加 taskId / goalRef / 结构化 state。
 *   - 脱敏覆盖**投影与注入**：fold 时就 redact，注入不会把原始密钥带进上下文。
 *   - 注入只在 resume / compaction / goal-change / milestone 触发，不再每轮重复同一段正文。
 *   - 原子替换在 Windows 上对 EPERM/EBUSY 做有限重试；POSIX 收紧文件与目录权限。
 *   - 宿主能力（sessionProjections / defineTool / createUserMessage / zod）缺失时逐项降级，
 *     不再因为一个服务缺失就整插件加载失败。
 */

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { homedir } = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

const mode = require('./package.json').name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
const tool = mode + '_checkpoint';
const key = mode + 'CheckpointV2';
const SCHEMA_VERSION = 2;
const limit = 800;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_STATE_ITEMS = 8;
const init = () => ({ note: '', turn: -1, pending: [], refresh: 0 });
const hash = text => createHash('sha256').update(text).digest('hex');
const describe = error => (error instanceof Error ? error.message : String(error));

// ── 敏感字段过滤（R9） ──────────────────────────────────────────────────────
// 断点会落盘，因此写入前先按已知形态过滤密钥/token/密码。宁可多过滤，也不要把
// 凭据留在明文 JSON 里；命中时工具会告诉模型「已过滤」。
// 注意：这是**正则脱敏**，不是完整的秘密扫描器，无法保证识别所有凭据或隐私数据。
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

/** 结构化字段同样过滤（只处理字符串与数组/对象里的字符串）。 */
function redactDeep(value, depth = 0) {
  if (depth > 8) return '[已截断]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 32).map(item => redactDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 32)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
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
// 路径：<DSH_HOME>/checkpoints/<profile>/<sha256(sessionId)[0..32]>.json
// 并发：一个会话只有一个写者；临时文件 + 原子 rename，最后写入者生效。
// 容错：损坏/超大/未知 schema 时隔离为 .corrupt-<ts>.json，按空断点重建，不崩。
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

function migrateV1(value) {
  return {
    note: value.note,
    state: {},
    taskId: '',
    goalRef: null,
    migratedFrom: 1,
  };
}

/** 返回 { note, status, doc }；status ∈ ok / empty / foreign / corrupt / unreadable / oversize。 */
async function loadCheckpoint(sessionId) {
  const file = checkpointPath(sessionId);
  let text;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) {
      const moved = await quarantine(file);
      warn('断点文件超过 ' + MAX_FILE_BYTES + ' 字节，已隔离为 ' + (moved || '（重命名失败）') + '，按空断点重建。');
      return { note: '', status: 'oversize', doc: null };
    }
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') warn('断点文件读取失败，按空断点处理：' + describe(error));
    return { note: '', status: error?.code === 'ENOENT' ? 'empty' : 'unreadable', doc: null };
  }

  let value;
  try {
    value = JSON.parse(text);
    if (value?.schemaVersion !== 1 && value?.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('schemaVersion 不是 1 或 ' + SCHEMA_VERSION);
    }
    if (typeof value.note !== 'string') throw new Error('note 不是字符串');
    if (value.schemaVersion === SCHEMA_VERSION) {
      if (value.state !== undefined && (value.state === null || typeof value.state !== 'object')) {
        throw new Error('state 不是对象');
      }
      if (value.goalRef !== undefined && value.goalRef !== null && typeof value.goalRef !== 'object') {
        throw new Error('goalRef 不是对象');
      }
      if (JSON.stringify(value.state ?? {}).length > MAX_STATE_BYTES) throw new Error('state 超过大小上限');
    }
  } catch (error) {
    const moved = await quarantine(file);
    warn('断点文件损坏（' + describe(error) + '），已隔离为 ' + (moved || '（重命名失败，下次 save 覆盖）') + '，按空断点重建。');
    return { note: '', status: 'corrupt', doc: null };
  }

  if (value.sessionId !== String(sessionId)) return { note: '', status: 'foreign', doc: null };
  const doc = value.schemaVersion === 1 ? migrateV1(value) : {
    note: value.note,
    state: value.state ?? {},
    taskId: typeof value.taskId === 'string' ? value.taskId : '',
    goalRef: value.goalRef ?? null,
    migratedFrom: value.migratedFrom ?? null,
  };
  return { note: redact(value.note).slice(0, limit), status: 'ok', doc };
}

async function readCheckpoint(sessionId) {
  return (await loadCheckpoint(sessionId)).note;
}

async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    await fs.writeFile(temp, text, 'utf8');
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rename(temp, file);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        // Windows 上目标被占用/被杀软扫描会 EPERM/EBUSY/EACCES；短暂等待后重试。
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) break;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  // 平台支持时收紧权限；失败只告警，不影响写入结果。
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(file, 0o600);
      await fs.chmod(path.dirname(file), 0o700);
    } catch (error) {
      warn('断点权限收紧失败（不影响内容）：' + describe(error));
    }
  }
}

/** 写入前统一过滤敏感字段；返回实际落盘的（可能被截断/过滤的）文本。 */
async function writeCheckpoint(sessionId, note, doc, options = {}) {
  const file = checkpointPath(sessionId);
  const stored = redact(note).slice(0, limit);
  const writeSchema = options.writeSchema === 1 ? 1 : SCHEMA_VERSION;
  const state = redactDeep(doc?.state ?? {});
  if (JSON.stringify(state).length > MAX_STATE_BYTES) throw new Error('断点结构化内容超过 ' + MAX_STATE_BYTES + ' 字节');
  const payload = writeSchema === 1
    ? { schemaVersion: 1, sessionId: String(sessionId), profile: profileName(), note: stored, updatedAt: new Date().toISOString() }
    : {
      schemaVersion: SCHEMA_VERSION,
      sessionId: String(sessionId),
      profile: profileName(),
      taskId: typeof doc?.taskId === 'string' ? doc.taskId.slice(0, 64) : '',
      goalRef: doc?.goalRef && typeof doc.goalRef === 'object'
        ? { id: String(doc.goalRef.id ?? '').slice(0, 64), revision: Number(doc.goalRef.revision) || 0 }
        : null,
      note: stored,
      state,
      updatedAt: new Date().toISOString(),
    };
  await writeFileAtomic(file, JSON.stringify(payload) + '\n');
  return stored;
}

async function clearCheckpoint(sessionId) {
  await fs.rm(checkpointPath(sessionId), { force: true });
}

// 只折叠 checkpoint 自己的调用；运行时防循环由 loop-guard.cjs 承担（R1）。
// 注意：这里就对 note 做 redact，保证投影态里也不留明文密钥。
function fold(s, event) {
  const d = event.data;
  if (event.type === 'turn/start') return { ...s, turn: d.turn, pending: [] };
  if (event.type === 'compaction/end') return { ...s, refresh: event.seq + 1 };
  if (event.type === 'tool/call') {
    if (d.name !== tool || typeof d.arguments !== 'string' || d.arguments.length > 65536) return s;
    let args;
    try { args = JSON.parse(d.arguments); } catch { return s; }
    let update = null;
    if (args?.action === 'save' && typeof args.note === 'string') update = redact(args.note.trim()).slice(0, limit);
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

/** 只保留允许注入的原因；默认四项全开。 */
const DEFAULT_INJECT_ON = ['resume', 'compaction', 'goal-change', 'milestone'];

function summarize(doc, budget) {
  const state = doc?.state ?? {};
  const lines = [];
  if (doc?.goalRef && doc.goalRef.id) lines.push('目标版本：' + doc.goalRef.id + '#' + doc.goalRef.revision);
  const goal = state.goal;
  if (goal && typeof goal === 'object') {
    if (goal.objective) lines.push('目标：' + String(goal.objective).slice(0, 120));
    if (Array.isArray(goal.acceptance) && goal.acceptance.length) {
      lines.push('验收：' + goal.acceptance.slice(0, 3).map(item => String(item).slice(0, 60)).join('；'));
    }
  }
  if (Array.isArray(state.excluded) && state.excluded.length) {
    lines.push('已排除：' + state.excluded.slice(0, 3).map(item => String(item.reason ?? item).slice(0, 60)).join('；'));
  }
  if (state.nextAction) lines.push('下一步：' + String(state.nextAction).slice(0, 120));
  const text = lines.join('\n');
  return text.length > budget ? text.slice(0, budget) + '…' : text;
}

exports.name = mode + '-session-memory';
exports.inject = ['tools'];

exports.apply = async function apply(ctx, config = {}) {
  const settings = {
    writeSchema: Number(config.writeSchema) === 1 ? 1 : SCHEMA_VERSION,
    injectOn: Array.isArray(config.injectOn) && config.injectOn.length
      ? config.injectOn.filter(item => DEFAULT_INJECT_ON.includes(item))
      : DEFAULT_INJECT_ON.slice(),
    maxInjectChars: Number.isInteger(Number(config.maxInjectChars))
      ? Math.min(2000, Math.max(200, Number(config.maxInjectChars)))
      : 800,
  };

  let host = null;
  let defineTool = null;
  let createUserMessage = null;
  let z = null;
  if (typeof config.hostManifest === 'string' && config.hostManifest !== '') {
    try {
      host = createRequire(config.hostManifest);
    } catch (error) {
      warn('hostManifest 无法解析，断点工具与投影降级：' + describe(error));
    }
  }
  if (host) {
    try { ({ defineTool } = host('@deepseek-ai/dsh-tools')); } catch (error) { warn('缺少 dsh-tools，断点工具不注册：' + describe(error)); }
    try { ({ createUserMessage } = host('@deepseek-ai/dsh-llm')); } catch (error) { warn('缺少 dsh-llm，注入退化为纯文本：' + describe(error)); }
    try { ({ z } = host('zod')); } catch (error) { warn('缺少 zod，投影降级为仅文件：' + describe(error)); }
  }

  // 投影是可选的：缺失时只用文件，不影响工具本身。
  let projection = null;
  const projections = ctx?.sessionProjections
    ?? (typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined);
  if (projections?.register && typeof z === 'function') {
    try {
      const pendingCall = z.object({ id: z.string(), update: z.string().nullable() });
      const schema = z.object({ note: z.string(), turn: z.number(), pending: z.array(pendingCall), refresh: z.number() });
      projection = await projections.register({ key, stateVersion: 2, stateSchema: schema, init, apply: fold });
    } catch (error) {
      warn('sessionProjections 注册失败，断点降级为仅文件：' + describe(error));
      projection = null;
    }
  }

  const durable = new Map();
  const durableDoc = async sessionId => {
    const id = String(sessionId);
    if (!durable.has(id)) {
      const loaded = await loadCheckpoint(id);
      durable.set(id, loaded);
    }
    return durable.get(id);
  };

  /** 投影读取必须容错：宿主没有 agent.session 或投影未注册时不能把步骤打崩。 */
  const projectionState = agent => {
    if (!projection) return null;
    try {
      return projection.stateOf(agent?.session ?? agent) ?? null;
    } catch (error) {
      warn('读取投影失败，本次只用文件断点：' + describe(error));
      return null;
    }
  };

  if (typeof defineTool === 'function' && typeof ctx.tools?.register === 'function') {
    ctx.tools.register(defineTool({
      name: tool,
      description: '本会话的任务断点。save 覆盖旧记录并落盘（可选结构化字段：goal/scope/acceptance/excluded/decisions/runs/counterexamples），read 读取，clear 清除。note 最多 800 字符；结构化内容最多 16 KB；密钥/token/密码类字段会在落盘与注入前被过滤。',
      parameters: {
        action: { type: 'string', enum: ['save', 'read', 'clear'], required: true },
        note: { type: 'string' },
        goal: {
          type: 'object',
          additionalProperties: false,
          properties: {
            objective: { type: 'string' },
            scope: { type: 'string' },
            constraints: { type: 'array', items: { type: 'string' } },
            acceptance: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
          },
        },
        nextAction: { type: 'string' },
        excluded: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        runs: { type: 'array', items: { type: 'string' } },
        counterexamples: { type: 'array', items: { type: 'string' } },
        taskId: { type: 'string' },
        goalRef: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, revision: { type: 'number' } },
        },
      },
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('需要当前 Agent 会话');
        const sessionId = String(exec.agent.id ?? exec.agent.session?.id ?? '');
        if (args.action === 'read') {
          const loaded = await loadCheckpoint(sessionId);
          if (loaded.note) return loaded.note;
          const fallback = projectionState(exec.agent)?.note;
          if (fallback) return fallback;
          return '当前没有任务断点。';
        }
        if (args.action === 'clear') {
          await clearCheckpoint(sessionId);
          durable.delete(sessionId);
          return '已清除当前断点。';
        }
        if (args.action !== 'save' || !args.note?.trim() || args.note.length > limit) {
          throw new Error('save 需要 1–800 字符的断点。');
        }
        const note = args.note.trim();
        const state = {};
        for (const field of ['goal', 'excluded', 'decisions', 'runs', 'counterexamples', 'nextAction']) {
          const value = args[field];
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) {
            if (value.length > MAX_STATE_ITEMS) throw new Error(`${field} 最多 ${MAX_STATE_ITEMS} 条`);
            state[field] = value.map(item => String(item).slice(0, 200));
          } else if (typeof value === 'object') {
            state[field] = {
              objective: value.objective ? String(value.objective).slice(0, 200) : undefined,
              scope: value.scope ? String(value.scope).slice(0, 120) : undefined,
              constraints: Array.isArray(value.constraints) ? value.constraints.slice(0, MAX_STATE_ITEMS).map(String) : undefined,
              acceptance: Array.isArray(value.acceptance) ? value.acceptance.slice(0, MAX_STATE_ITEMS).map(String) : undefined,
              assumptions: Array.isArray(value.assumptions) ? value.assumptions.slice(0, MAX_STATE_ITEMS).map(String) : undefined,
            };
          } else {
            state[field] = String(value).slice(0, 200);
          }
        }
        let stored;
        try {
          stored = await writeCheckpoint(sessionId, note, {
            taskId: args.taskId,
            goalRef: args.goalRef,
            state,
          }, { writeSchema: settings.writeSchema });
        } catch (error) {
          throw new Error('断点落盘失败：' + describe(error));
        }
        durable.delete(sessionId);
        return stored === note
          ? '已记录本次任务断点（已落盘）。'
          : '已记录本次任务断点（已落盘；疑似密钥字段已过滤）。';
      },
    }));
  } else {
    warn('defineTool 不可用，断点工具未注册（注入仍按文件内容工作）');
  }

  // 注入：只在 resume / compaction / goal-change / milestone 触发。
  const lastShown = new WeakMap();
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal?.aborted) return decision;
    const sessionId = String(agent?.id ?? '');
    const loaded = await durableDoc(sessionId);
    const projectionNote = projectionState(agent)?.note ?? '';
    const note = loaded.note || projectionNote;
    const doc = loaded.doc;
    if (!note && !doc?.state) return decision;

    const noteHash = hash(note);
    const refresh = projectionState(agent)?.refresh ?? 0;
    const goalRev = doc?.goalRef?.revision ?? null;
    const previous = lastShown.get(agent) ?? null;
    let reason = '';
    if (!previous) reason = 'resume';
    else if (previous.refresh !== refresh) reason = 'compaction';
    else if (previous.goalRev !== goalRev) reason = 'goal-change';
    else if (previous.noteHash !== noteHash) reason = 'milestone';
    if (!reason || !settings.injectOn.includes(reason)) {
      lastShown.set(agent, { noteHash, refresh, goalRev, turn });
      return decision;
    }
    lastShown.set(agent, { noteHash, refresh, goalRev, turn });

    const summary = doc?.state ? summarize(doc, Math.max(200, settings.maxInjectChars - 200)) : '';
    const header = reason === 'compaction'
      ? '上下文刚压缩过。以下是已落盘的会话记录（历史数据），先核对当前目标与版本再沿用。'
      : reason === 'goal-change'
        ? '目标版本已变化。以下是已落盘的会话记录（历史数据），旧结论需要重新确认适用性。'
        : '此前保存的会话记录（历史数据，已落盘）。先核对当前目标和版本，再沿用其中的判断。';
    const text = [header, JSON.stringify(note), summary].filter(Boolean).join('\n');
    const finalText = text.length > settings.maxInjectChars ? text.slice(0, settings.maxInjectChars) + '…' : text;
    const source = { kind: key, form: 'snapshot', sections: [{ name: key, text: finalText }] };
    const msg = typeof createUserMessage === 'function'
      ? createUserMessage({ content: [{ type: 'text', text: finalText }], source })
      : { role: 'user', content: [{ type: 'text', text: finalText }], source };
    return { ...decision, messages: [...decision.messages, msg] };
  }, { prepend: true });
};

exports._internals = {
  redact,
  redactDeep,
  fold,
  readCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  loadCheckpoint,
  checkpointPath,
  quarantine,
  summarize,
  limit,
  SCHEMA_VERSION,
  MAX_FILE_BYTES,
  MAX_STATE_BYTES,
  warnings,
};
