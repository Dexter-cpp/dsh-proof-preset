'use strict';

/**
 * 运行时防循环 hook。proof / deliberate 两个 preset 各带一份**完全相同**的实现，
 * 只有 <mode> 前缀不同，由各自 package.json 的 name 推导。
 *
 * 1.4.0 规则（与 1.3.1 的关键差异）：
 *   B1  连续相同**失败**调用：同工具 + 同参数签名 + 同失败结果连续 N 次后，第 N+1 次
 *       在 `tools/pre-execute` 被拒绝（REPEATED_IDENTICAL_FAILURE）。成功调用**永不硬拦**。
 *   B1' 连续相同输出：参数不同但同工具输出连续 N 次相同 → 只注入提示，不拒绝；
 *       streak 按工具隔离，非文本输出（图片/资源/结构化）也参与比较。
 *   C2  停滞自检：由状态触发（连续 N 轮没有新证据 / 目标版本变化），不再按
 *       "第 N 个用户轮次"机械注入（`selfCheckEvery` 仅为 1.3.1 兼容保留，默认 0）。
 *
 * 稳定性：监听器全程 try/catch，异常降级为放行 + 日志；签名与输出哈希用
 * **全量流式** canonical 编码（无 8 KB 截断、无前缀碰撞），BigInt/循环/抛错访问器
 * 都有确定性标记，不会让守卫崩溃或静默失效。
 */

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const bus = require('./state-bus.cjs');
const ledger = require('./ledger.cjs');

const MODE = (() => {
  try {
    return require('./package.json').name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
  } catch {
    return 'deliberate';
  }
})();

const DENIAL_CODE = 'REPEATED_IDENTICAL_FAILURE';
const NOTICE_KIND = MODE + 'LoopGuard';
const CHECKPOINT_TOOL = MODE + '_checkpoint';
const DIRECTIONS_TOOL = MODE + '_directions';
const HYPOTHESES_TOOL = MODE + '_hypotheses';
const STATS_TOOL = MODE + '_guard_stats';

const DEFAULTS = {
  enabled: true,
  denyOn: 'failure',
  threshold: 3,
  outputStreakThreshold: 3,
  stallRounds: 3,
  selfCheckEvery: 0,
  maxNoticesPerTurn: 2,
  stats: 'off',
};

const RANGES = {
  threshold: [2, 10],
  outputStreakThreshold: [2, 10],
  stallRounds: [2, 10],
  selfCheckEvery: [0, 50],
  maxNoticesPerTurn: [1, 3],
};

const MAX_STATES = 2048;
const MAX_NOTICES = 4;
const MAX_DIRECTIONS = 3;
const MAX_DIRECTION_CHARS = 200;
const LOG_LIMIT = 50;
const MAX_DEPTH = 64;
const SELF_CHECK_INSTRUCTION = '当前做法是否在重复之前失败过的路径？';

const EXCLUDED_TOOLS = new Set([
  CHECKPOINT_TOOL,
  DIRECTIONS_TOOL,
  HYPOTHESES_TOOL,
  STATS_TOOL,
  'proof_checkpoint',
  'deliberate_checkpoint',
  'proof_hypotheses',
  'deliberate_hypotheses',
  'proof_guard_stats',
  'deliberate_guard_stats',
  'todo_write',
]);

/** 只影响展示、不改变操作的参数；同一命令换一句 description 不应被当成新策略。 */
const PRESENTATION_KEYS = new Set(['description', 'title', 'summary', 'label']);

const describe = error => (error instanceof Error ? error.message : String(error));

// ── 日志 ───────────────────────────────────────────────────────────────────

const logs = [];
function log(message) {
  try {
    const entry = new Date().toISOString() + ' ' + message;
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();
    process.stderr.write('[loop-guard] ' + message + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ── 配置校验（有上下限，非法值夹取并告警） ─────────────────────────────────

function resolveInt(value, fallback, range, name) {
  const [min, max] = range;
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(value));
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    log(`配置 ${name}=${JSON.stringify(value)} 不是整数，已回退默认值 ${fallback}`);
    return fallback;
  }
  if (number < min || number > max) {
    const clamped = Math.min(max, Math.max(min, number));
    log(`配置 ${name}=${number} 超出 ${min}..${max}，已夹取为 ${clamped}`);
    return clamped;
  }
  return number;
}

function resolveBool(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  log(`配置 ${name}=${JSON.stringify(value)} 不是布尔值，已回退默认值 ${fallback}`);
  return fallback;
}

function resolveEnum(value, allowed, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (allowed.includes(value)) return value;
  log(`配置 ${name}=${JSON.stringify(value)} 不在 ${allowed.join('/')} 内，已回退 ${fallback}`);
  return fallback;
}

/** 兼容 1.3.1 的导出：只校验正整数。 */
function resolvePositiveInt(value, fallback, name) {
  return resolveInt(value, fallback, [1, Number.MAX_SAFE_INTEGER], name);
}

// ── canonical 编码（全量、确定性、可降级） ──────────────────────────────────

const TAG = {
  undef: '{"$u":1}',
  fn: '{"$fn":1}',
  sym: '{"$sym":1}',
  nan: '{"$n":"NaN"}',
  inf: '{"$n":"Inf"}',
  ninf: '{"$n":"-Inf"}',
  nzero: '{"$n":"-0"}',
  deep: '{"$deep":1}',
};

function writeNumber(sink, value) {
  if (Number.isNaN(value)) return sink.update(TAG.nan);
  if (value === Infinity) return sink.update(TAG.inf);
  if (value === -Infinity) return sink.update(TAG.ninf);
  if (Object.is(value, -0)) return sink.update(TAG.nzero);
  return sink.update(JSON.stringify(value));
}

/**
 * 把一个值以确定性文本流写进 hash。不拼接大字符串，内存 O(depth)。
 * 所有"不可序列化"情形都有固定标记，保证同一输入永远同一签名。
 */
function writeCanonical(sink, value, seen, depth) {
  if (depth > MAX_DEPTH) return sink.update(TAG.deep);
  const type = typeof value;
  if (value === null) return sink.update('null');
  if (type === 'undefined') return sink.update(TAG.undef);
  if (type === 'boolean') return sink.update(value ? 'true' : 'false');
  if (type === 'number') return writeNumber(sink, value);
  if (type === 'bigint') return sink.update('{"$b":"' + value.toString() + '"}');
  if (type === 'string') return sink.update(JSON.stringify(value));
  if (type === 'function') return sink.update(TAG.fn);
  if (type === 'symbol') return sink.update(TAG.sym);

  if (seen.has(value)) return sink.update('{"$cycle":"' + seen.get(value) + '"}');

  if (value instanceof Date) {
    const time = value.getTime();
    return sink.update('{"$date":"' + (Number.isNaN(time) ? 'invalid' : value.toISOString()) + '"}');
  }
  if (value instanceof Error) {
    return sink.update('{"$error":' + JSON.stringify({
      name: String(value.name || 'Error'),
      message: String(value.message || ''),
      code: value.code === undefined ? '' : String(value.code),
    }) + '}');
  }
  if (Buffer.isBuffer(value)) {
    sink.update('{"$buffer":{"len":' + value.length + ',"sha256":"');
    sink.update(createHash('sha256').update(value).digest('hex'));
    return sink.update('"}}');
  }
  if (value instanceof Uint8Array) {
    sink.update('{"$u8":{"len":' + value.length + ',"sha256":"');
    sink.update(createHash('sha256').update(Buffer.from(value)).digest('hex'));
    return sink.update('"}}');
  }

  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch (error) {
    return sink.update('{"$proxy":"' + describe(error).slice(0, 40) + '"}');
  }

  if (isArray) {
    seen.set(value, '#/' + depth);
    sink.update('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) sink.update(',');
      let item;
      try {
        item = value[index];
      } catch (error) {
        sink.update('{"$throw":"' + describe(error).slice(0, 40) + '"}');
        continue;
      }
      writeCanonical(sink, item, seen, depth + 1);
    }
    sink.update(']');
    seen.delete(value);
    return undefined;
  }

  let keys;
  try {
    keys = Object.keys(value).sort();
  } catch (error) {
    return sink.update('{"$proxy":"' + describe(error).slice(0, 40) + '"}');
  }
  seen.set(value, '#/' + depth);
  sink.update('{');
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index > 0) sink.update(',');
    sink.update(JSON.stringify(key) + ':');
    let item;
    try {
      item = value[key];
    } catch (error) {
      sink.update('{"$throw":"' + describe(error).slice(0, 40) + '"}');
      continue;
    }
    writeCanonical(sink, item, seen, depth + 1);
  }
  sink.update('}');
  seen.delete(value);
  return undefined;
}

function stripPresentation(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  try {
    return Object.fromEntries(Object.entries(args).filter(([key]) => !PRESENTATION_KEYS.has(key)));
  } catch (error) {
    return { $unreadable: describe(error).slice(0, 60) };
  }
}

/** 工具名 + 参数规范化 SHA256（v2：全量、无截断、稳定键序）。 */
function signature(name, args) {
  const sink = createHash('sha256');
  sink.update('sig/v2\n');
  sink.update(String(name));
  sink.update('\n');
  try {
    writeCanonical(sink, stripPresentation(args), new Map(), 0);
  } catch (error) {
    sink.update('{"$fail":"' + describe(error).slice(0, 60) + '"}');
  }
  return sink.digest('hex');
}

// ── 输出哈希 ───────────────────────────────────────────────────────────────

function blocksOf(result) {
  const content = result?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function writeBlocks(sink, blocks) {
  sink.update('#' + blocks.length + '\n');
  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      sink.update('raw\0');
      writeCanonical(sink, block, new Map(), 0);
      continue;
    }
    const type = String(block.type ?? 'unknown');
    sink.update('blk\0' + type + '\0');
    if (type === 'text') {
      sink.update('text\0' + String(block.text ?? ''));
    } else if (type === 'image') {
      const source = block.source ?? {};
      sink.update('image\0' + String(block.mimeType ?? source.media_type ?? '') + '\0' + String(source.data ?? ''));
    } else if (type === 'resource') {
      const resource = block.resource ?? {};
      sink.update('resource\0' + String(resource.uri ?? '') + '\0' + String(resource.text ?? ''));
    } else {
      writeCanonical(sink, block, new Map(), 0);
    }
    sink.update('\0');
  }
}

/** 输出 hash：状态 + 错误码 + 全部 content block（含非文本）。 */
function outputKey(result) {
  const failed = result?.isError === true || result?.error !== undefined;
  const code = failed ? String(result?.error?.code ?? result?.error?.info?.code ?? '') : '';
  const sink = createHash('sha256');
  sink.update('out/v2\n');
  sink.update(failed ? 'error\n' : 'ok\n');
  sink.update(code);
  sink.update('\n');
  try {
    writeBlocks(sink, blocksOf(result));
  } catch (error) {
    sink.update('{"$fail":"' + describe(error).slice(0, 60) + '"}');
  }
  return sink.digest('hex');
}

/** 输出文本（完整，不截断；仅用于判断"有没有内容"与兼容旧调用）。 */
function outputText(result) {
  const blocks = blocksOf(result);
  const parts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 有内容即算"带来信息"：文本非空，或存在任何非文本 block。 */
function hasOutput(result) {
  const blocks = blocksOf(result);
  if (blocks.length === 0) return false;
  return blocks.some(block => {
    if (!block || typeof block !== 'object') return true;
    if (block.type === 'text') return String(block.text ?? '').trim() !== '';
    return true;
  });
}

// ── 状态 ───────────────────────────────────────────────────────────────────

function createState() {
  return {
    // B1：连续相同失败调用
    tool: '',
    signature: '',
    failed: false,
    count: 0,
    // B1'：按工具的输出 streak
    streaks: new Map(),
    // C2：停滞与目标
    lastTurn: null,
    rounds: 0,
    evidenceSeq: 0,
    goalRev: null,
    denials: 0,
    rejectedTurn: null,
    // 通知队列与去重水位
    notices: [],
    shown: 0,
    token: 0,
    // C1：方向记录（兼容 1.3.1）
    directions: [],
    // 统计（默认只在内存）
    stats: { observed: 0, soft: 0, denied: 0, recovered: 0, byTool: {} },
  };
}

function toolStats(state, name) {
  const key = String(name || '');
  if (!state.stats.byTool[key]) state.stats.byTool[key] = { calls: 0, soft: 0, denied: 0 };
  return state.stats.byTool[key];
}

function pushNotice(state, notice, limit = MAX_NOTICES) {
  // 同一 (reason, tool) 未展示前不重复堆叠，避免一轮里刷出三条一样的提示。
  if (state.notices.some(item => item.reason === notice.reason && item.tool === notice.tool && item.token > state.shown)) return;
  state.token += 1;
  state.notices.push({ ...notice, token: state.token });
  if (state.notices.length > limit) state.notices = state.notices.slice(-limit);
}

// ── 文案 ───────────────────────────────────────────────────────────────────

function loopInstruction(count) {
  return `当前做法已连续 ${count} 次得到相同失败，请换一个可检验的新策略，并先说明新假设与判定标准。`;
}

function directionLines(directions) {
  if (!Array.isArray(directions) || directions.length === 0) return [];
  return [
    '已记录的方向（先回看，别急着重想）：',
    ...directions.map((item, index) => `${index + 1}. ${item}`),
    '先检查这些方向里有没有还没试过、但确实能用的；都不适用再重想。',
  ];
}

function noticeText(reason, count, tool, directions, extra = {}) {
  const lines = [];
  if (reason === 'self' || reason === 'self-legacy') {
    lines.push('[事前自检]', SELF_CHECK_INSTRUCTION,
      '若在重复，先换假设并说明什么观察能区分新旧解释；不要等失败三次才回头。');
  } else if (reason === 'stall') {
    lines.push('[停滞检查]',
      `连续 ${count} 轮没有新证据。先用一句话写出当前假设，以及下一个能区分新旧解释的观察；`,
      '写不出可区分的观察就按止损处理：给出已有结果、已排除解释、当前阻塞与最小恢复条件。');
  } else if (reason === 'goal') {
    lines.push('[目标变更]',
      '目标版本已变化，旧假设与旧方向已归档，不再作为当前提示。',
      '重新确认验收条件后再继续；不要把归档的结论当成当前结论。');
  } else if (reason === 'output') {
    lines.push('[运行时防循环]',
      `连续 ${count} 次得到相同输出（调用参数不同，工具 ${tool || '未知'}），本次调用已执行但没有带来新信息。`,
      '换一个能改变输出的检查，而不是原样重试。');
  } else {
    lines.push('[运行时防循环]',
      `同一工具、同一参数和同一失败结果已连续 ${count} 次${tool ? `（${tool}）` : ''}，本次调用未执行。`,
      loopInstruction(count),
      '若确认是同一阻塞，直接报告阻塞和所需的最小信息。');
  }
  if (extra && Array.isArray(extra.excluded) && extra.excluded.length > 0) {
    lines.push('已排除的解释：' + extra.excluded.slice(0, 3).join('；'));
  }
  lines.push(...directionLines(directions));
  return lines.join('\n');
}

function normalizeDirections(items) {
  if (!Array.isArray(items)) throw new Error('items 需要字符串数组');
  const cleaned = items.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  if (cleaned.length === 0) throw new Error('至少记录 1 个方向');
  if (cleaned.length > MAX_DIRECTIONS) throw new Error(`最多记录 ${MAX_DIRECTIONS} 个方向`);
  for (const item of cleaned) {
    if (item.length > MAX_DIRECTION_CHARS) throw new Error(`单个方向最多 ${MAX_DIRECTION_CHARS} 字符`);
  }
  return cleaned;
}

// ── 插件 ───────────────────────────────────────────────────────────────────

exports.name = MODE + '-loop-guard';
exports.inject = ['tools'];

exports.apply = async function apply(ctx, config = {}) {
  const settings = {
    enabled: resolveBool(config.enabled, DEFAULTS.enabled, 'loop-guard.enabled'),
    denyOn: resolveEnum(config.denyOn, ['failure', 'never'], DEFAULTS.denyOn, 'loop-guard.denyOn'),
    threshold: resolveInt(config.threshold, DEFAULTS.threshold, RANGES.threshold, 'loop-guard.threshold'),
    outputStreakThreshold: resolveInt(config.outputStreakThreshold, DEFAULTS.outputStreakThreshold,
      RANGES.outputStreakThreshold, 'loop-guard.outputStreakThreshold'),
    stallRounds: resolveInt(config.stallRounds, DEFAULTS.stallRounds, RANGES.stallRounds, 'loop-guard.stallRounds'),
    selfCheckEvery: resolveInt(config.selfCheckEvery, DEFAULTS.selfCheckEvery, RANGES.selfCheckEvery, 'loop-guard.selfCheckEvery'),
    maxNoticesPerTurn: resolveInt(config.maxNoticesPerTurn, DEFAULTS.maxNoticesPerTurn,
      RANGES.maxNoticesPerTurn, 'loop-guard.maxNoticesPerTurn'),
    stats: resolveEnum(config.stats, ['off', 'memory'], DEFAULTS.stats, 'loop-guard.stats'),
  };

  const budget = config.budget && typeof config.budget === 'object' ? config.budget : {};
  ledger.configure({
    maxHypotheses: resolveInt(budget.maxHypotheses, 20, [1, 50], 'budget.maxHypotheses'),
    maxStatementChars: resolveInt(budget.maxStatementChars, 240, [80, 500], 'budget.maxStatementChars'),
    maxEvidencePerHypothesis: resolveInt(budget.maxEvidencePerHypothesis, 5, [1, 10], 'budget.maxEvidencePerHypothesis'),
    maxStateBytes: resolveInt(budget.maxStateBytes, 8192, [2048, 65536], 'budget.maxStateBytes'),
  });

  // hostManifest 缺失或解析失败只影响「注入消息」与「记账工具」，不影响拦截本身。
  let host = null;
  let createUserMessage = null;
  let defineTool = null;
  if (typeof config.hostManifest === 'string' && config.hostManifest !== '') {
    try {
      host = createRequire(config.hostManifest);
      ({ createUserMessage } = host('@deepseek-ai/dsh-llm'));
    } catch (error) {
      log('加载 @deepseek-ai/dsh-llm 失败，注入消息退化为纯文本消息：' + describe(error));
      createUserMessage = null;
    }
    try {
      if (host) ({ defineTool } = host('@deepseek-ai/dsh-tools'));
    } catch (error) {
      log('加载 @deepseek-ai/dsh-tools 失败，记账工具不注册：' + describe(error));
      defineTool = null;
    }
  } else {
    log('缺少 hostManifest，注入消息退化为纯文本消息，记账工具不注册');
  }

  const states = new Map();
  const stateOf = agent => {
    const id = String(agent?.id ?? '');
    let state = states.get(id);
    if (!state) {
      if (states.size >= MAX_STATES) states.delete(states.keys().next().value);
      state = createState();
      states.set(id, state);
    }
    return state;
  };

  const sessionOf = exec => String(exec?.agent?.id ?? '');
  const canRegister = typeof defineTool === 'function' && typeof ctx.tools?.register === 'function';

  // C1 方向记录（兼容 1.3.1）：参数、返回文案、上限全部保持；同时镜像进假设账本。
  if (canRegister) {
    try {
      ctx.tools.register(defineTool({
        name: DIRECTIONS_TOOL,
        description: '记录本轮 1–3 个候选方向（各一句 + 一句利弊），会话内保留；卡住时防循环提示会引用它。不落盘，最多 3 条、每条 200 字符；同时作为 direction 类假设进入假设账本。',
        parameters: {
          action: { type: 'string', enum: ['set', 'read', 'clear'], required: true },
          items: { type: 'array', items: { type: 'string' } },
        },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          if (!exec?.agent) throw new Error('需要当前 Agent 会话');
          const state = stateOf(exec.agent);
          const sessionId = sessionOf(exec);
          if (args.action === 'read') {
            return state.directions.length
              ? state.directions.map((item, index) => `${index + 1}. ${item}`).join('\n')
              : '当前没有记录方向。';
          }
          if (args.action === 'clear') {
            state.directions = [];
            for (const item of ledger.list(sessionId)) {
              if (item.axis === 'direction') ledger.archive(sessionId, item.id, 'directions.clear');
            }
            return '已清除方向记录。';
          }
          if (args.action !== 'set') throw new Error('action 只能是 set / read / clear');
          const items = normalizeDirections(args.items);
          state.directions = items;
          const existing = new Set(ledger.list(sessionId).filter(item => item.axis === 'direction').map(item => item.statement));
          for (const statement of items) {
            if (existing.has(statement)) continue;
            try {
              ledger.set(sessionId, { statement, axis: 'direction', risk: 'medium', taskId: bus.snapshot(sessionId).taskId });
            } catch (error) {
              log('方向镜像进账本失败（不影响方向记录）：' + describe(error));
            }
          }
          return `已记录 ${items.length} 个方向（会话内保留，卡住时会被引用）。`;
        },
      }));
    } catch (error) {
      log('注册方向记录工具失败，仅保留提示文案：' + describe(error));
    }

    // 结构化假设账本。
    try {
      ctx.tools.register(defineTool({
        name: HYPOTHESES_TOOL,
        description: '结构化假设账本（会话内保留，不落盘）。set 新建；update 改状态（只能由证据驱动：supported 需有效非自证证据，falsified 需反例/矛盾且为终态）；read 列表；archive 归档；reopen 带新证据重开（falsified 不可重开）。状态限 untested/testing/supported/falsified/blocked。',
        parameters: {
          action: { type: 'string', enum: ['set', 'update', 'read', 'archive', 'reopen'], required: true },
          id: { type: 'string' },
          statement: { type: 'string' },
          status: { type: 'string', enum: ledger.STATUSES },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          axis: { type: 'string', enum: ledger.AXES },
          nextCheck: { type: 'string' },
          confidence: { type: 'string', enum: ['unverified', 'partial', 'strict'] },
          supersedes: { type: 'string' },
          taskId: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['test', 'checker', 'proof', 'observation', 'review', 'self'] },
                source: { type: 'string' },
                result: { type: 'string' },
                validity: { type: 'string', enum: ['valid', 'invalid'] },
              },
            },
          },
          expect: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ifSupport: { type: 'string' },
              ifRefute: { type: 'string' },
              invalidIf: { type: 'string' },
            },
          },
        },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          if (!exec?.agent) throw new Error('需要当前 Agent 会话');
          const sessionId = sessionOf(exec);
          if (args.taskId) bus.setTask(sessionId, args.taskId);
          const taskId = bus.snapshot(sessionId).taskId;
          if (args.action === 'read') return ledger.view(sessionId);
          if (args.action === 'set') {
            const item = ledger.set(sessionId, { ...args, taskId });
            bus.noteEvidence(sessionId, { kind: 'hypothesis' });
            const warn = ledger.falsifiedFingerprints(sessionId).has(item.fingerprint)
              ? '\n注意：已有同义假设被证伪；本次为新建记录，请说明与旧结论的差异。'
              : '';
            return `已记录 ${item.id}（${item.status}）：${item.statement}${warn}`;
          }
          if (!args.id) throw new Error('update/archive/reopen 需要 id');
          if (args.action === 'archive') {
            const item = ledger.archive(sessionId, args.id, args.statement || '');
            return `已归档 ${item.id}。`;
          }
          if (args.action === 'reopen') {
            const evidence = Array.isArray(args.evidence) ? args.evidence[0] : args.evidence;
            const item = ledger.reopen(sessionId, args.id, evidence);
            bus.noteEvidence(sessionId, { kind: 'reopen' });
            return `已重开 ${item.id}（${item.status}）。`;
          }
          const item = ledger.update(sessionId, args.id, args);
          bus.noteEvidence(sessionId, { kind: 'hypothesis' });
          return `${item.id} 现为 ${item.status}；证据 ${item.evidence.length} 条。`;
        },
      }));
    } catch (error) {
      log('注册假设账本工具失败：' + describe(error));
    }

    // 统计（只读；默认不记录参数正文）。
    try {
      ctx.tools.register(defineTool({
        name: STATS_TOOL,
        description: '读取本会话的守卫统计：观察次数、软提示、硬拦截、误判恢复、按工具分布。不记录参数正文。reset 只清零本会话计数。',
        parameters: { action: { type: 'string', enum: ['read', 'reset'], required: true } },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          if (!exec?.agent) throw new Error('需要当前 Agent 会话');
          const state = stateOf(exec.agent);
          if (args.action === 'reset') {
            state.stats = { observed: 0, soft: 0, denied: 0, recovered: 0, byTool: {} };
            return '已清零本会话守卫统计。';
          }
          if (args.action !== 'read') throw new Error('action 只能是 read / reset');
          const snapshot = bus.snapshot(sessionOf(exec));
          return JSON.stringify({
            observed: state.stats.observed,
            soft: state.stats.soft,
            denied: state.stats.denied,
            recovered: state.stats.recovered,
            byTool: state.stats.byTool,
            stallRounds: state.rounds,
            evidenceSeq: snapshot.evidenceSeq,
            goalRef: snapshot.goalRef,
          });
        },
      }));
    } catch (error) {
      log('注册统计工具失败：' + describe(error));
    }
  }

  // ── B1：拦截（只拦失败重复） ──────────────────────────────────────────────
  ctx.on('tools/pre-execute', (exec, next) => {
    let decision = null;
    try {
      if (settings.enabled && exec?.agent && !EXCLUDED_TOOLS.has(exec.name)) {
        const state = stateOf(exec.agent);
        state.stats.observed += 1;
        const perTool = toolStats(state, exec.name);
        perTool.calls += 1;
        const sig = signature(exec.name, exec.arguments);
        const repeatFailure = state.failed
          && state.count >= settings.threshold
          && state.tool === exec.name
          && state.signature === sig;
        if (settings.denyOn === 'failure' && repeatFailure) {
          state.denials += 1;
          state.stats.denied += 1;
          perTool.denied += 1;
          pushNotice(state, { reason: 'call', count: state.count, tool: exec.name });
          decision = {
            kind: 'deny',
            reason: noticeText('call', state.count, exec.name, state.directions, {}),
            info: { name: 'ModeLoopGuard', code: DENIAL_CODE },
          };
        }
      }
    } catch (error) {
      // hook 出错一律放行，绝不因为守卫自身异常阻断工具执行。
      log('pre-execute 异常，已放行本次调用：' + describe(error));
      decision = null;
    }
    return decision ?? next();
  });

  // ── B1 / B1'：观察结果 ────────────────────────────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!settings.enabled || !exec?.agent || EXCLUDED_TOOLS.has(exec.name)) return;
      // 本 hook 自己的拒绝不计入序列，否则会自我强化。
      if (result?.error?.info?.code === DENIAL_CODE || result?.error?.code === DENIAL_CODE) return;
      const state = stateOf(exec.agent);
      state.denials = 0;

      const failed = result?.isError === true || result?.error !== undefined;
      const sig = signature(exec.name, exec.arguments);
      if (state.tool === exec.name && state.signature === sig && state.failed === failed) {
        state.count += 1;
      } else {
        state.tool = exec.name;
        state.signature = sig;
        state.failed = failed;
        state.count = 1;
      }

      // 输出 streak 按工具隔离；没有内容（空 content / 纯空白文本）不参与。
      // 失败结果交给失败链处理，不再重复报“相同输出”（否则同一现象两条提示）。
      if (hasOutput(result) && !failed) {
        const key = outputKey(result);
        const streak = state.streaks.get(exec.name) ?? { hash: '', count: 0 };
        if (streak.hash === key) streak.count += 1;
        else { streak.hash = key; streak.count = 1; }
        state.streaks.set(exec.name, streak);
        if (streak.count >= settings.outputStreakThreshold) {
          pushNotice(state, { reason: 'output', count: streak.count, tool: exec.name });
        }
      }

      if (failed && state.count >= settings.threshold) {
        pushNotice(state, { reason: 'call', count: state.count, tool: exec.name });
      }
    } catch (error) {
      log('tools/result 异常，已忽略本次观测：' + describe(error));
    }
  });

  // ── C2 + 通知注入 ───────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision;
      const state = stateOf(payload?.agent);
      const sessionId = String(payload?.agent?.id ?? '');
      const fresh = beginStep(state, payload, sessionId);
      // 连续两次撞上同一拦截就结束本轮；同一轮只拒绝一次，避免宿主重复进入 pre-step 时无限拒绝。
      if (state.denials >= 2 && state.rejectedTurn !== payload?.turn) {
        state.rejectedTurn = payload?.turn;
        return { kind: 'reject' };
      }
      if (fresh.length === 0) return decision;
      const selected = fresh.slice(0, settings.maxNoticesPerTurn);
      for (const notice of selected) state.stats.soft += 1;
      const messages = selected.map(notice => makeMessage(noticeText(notice.reason, notice.count, notice.tool, state.directions, notice.extra)));
      return { ...decision, messages: [...(decision.messages ?? []), ...messages] };
    } catch (error) {
      log('pre-step 异常，跳过本次注入：' + describe(error));
      return decision;
    }
  }, { prepend: true });

  ctx.on('agent/disposed', payload => {
    try {
      const id = String(payload?.agent?.id ?? '');
      states.delete(id);
      ledger.drop(id);
      bus.drop(id);
    } catch (error) {
      log('agent/disposed 异常，已忽略：' + describe(error));
    }
  });

  /** C2：状态触发的停滞检查；返回本轮需要注入的通知。 */
  function beginStep(state, payload, sessionId) {
    if (payload?.turn !== state.lastTurn) {
      state.lastTurn = payload?.turn;
      state.denials = 0;
      state.rejectedTurn = null;
      state.rounds += 1;
    }

    try {
      const snap = bus.snapshot(sessionId);
      // 目标版本变化：归档旧假设，清空停滞计数。
      if (snap.goalRef && state.goalRev !== null && snap.goalRef.revision !== state.goalRev) {
        const archived = ledger.archiveAll(sessionId, 'goal-change');
        state.rounds = 0;
        state.stats.recovered += 1;
        pushNotice(state, { reason: 'goal', count: archived, tool: '' });
      }
      if (snap.goalRef) state.goalRev = snap.goalRef.revision;
      // 新证据：解除停滞。
      if (snap.evidenceSeq !== state.evidenceSeq) {
        state.evidenceSeq = snap.evidenceSeq;
        state.rounds = 0;
        state.stats.recovered += 1;
      }
    } catch (error) {
      log('同步会话信号失败：' + describe(error));
    }

    // 兼容 1.3.1：显式开启才按用户轮次自检（默认关闭）。
    if (settings.selfCheckEvery > 0
      && Number.isInteger(payload?.turn) && payload.turn > 0
      && payload.turn % settings.selfCheckEvery === 0) {
      pushNotice(state, { reason: 'self-legacy', count: payload.turn, tool: '' });
    }

    // 状态触发：连续 N 轮无新证据 → 一次停滞检查（触发后清零，避免每轮刷）。
    if (state.rounds >= settings.stallRounds) {
      pushNotice(state, { reason: 'stall', count: state.rounds, tool: '' });
      state.rounds = 0;
    }

    const fresh = state.notices.filter(notice => notice.token > state.shown);
    if (fresh.length > 0) {
      state.shown = fresh[fresh.length - 1].token;
      state.notices = state.notices.filter(notice => notice.token > state.shown);
    }
    return fresh;
  }

  function makeMessage(text) {
    const source = { kind: NOTICE_KIND, form: 'notice', summary: text.split('\n')[0].slice(0, 120) };
    if (typeof createUserMessage === 'function') {
      try {
        return createUserMessage({ content: [{ type: 'text', text }], source });
      } catch (error) {
        log('createUserMessage 失败，退化为纯文本消息：' + describe(error));
      }
    }
    return { role: 'user', content: [{ type: 'text', text }], source };
  }
};

exports._internals = {
  MODE,
  signature,
  outputKey,
  outputText,
  hasOutput,
  writeCanonical,
  createState,
  noticeText,
  loopInstruction,
  directionLines,
  normalizeDirections,
  resolvePositiveInt,
  resolveInt,
  resolveBool,
  resolveEnum,
  logs,
  DENIAL_CODE,
  SELF_CHECK_INSTRUCTION,
  CHECKPOINT_TOOL,
  DIRECTIONS_TOOL,
  HYPOTHESES_TOOL,
  STATS_TOOL,
  EXCLUDED_TOOLS,
  PRESENTATION_KEYS,
  settings: DEFAULTS,
};
