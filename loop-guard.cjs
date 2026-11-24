'use strict';

/**
 * 运行时防循环 hook。proof / deliberate 两个 preset 各带一份**完全相同**的实现，
 * 只有 <mode> 前缀不同，由各自 package.json 的 name 推导，避免两份代码走偏。
 *
 * 三条规则，两个计数器彼此独立（R3）：
 *   B1  连续相同调用：同一工具 + 同一参数签名 + 同一输出 hash 连续 N 次后，第 N+1 次
 *       在 `tools/pre-execute` 被拒绝（`REPEATED_IDENTICAL_FAILURE`），同时注入换路指令（R2）。
 *   B1' 连续相同输出：参数不同但输出 hash 连续 N 次相同 → 只注入提示，不拒绝
 *       （合法的重复检查不该被硬拦）。
 *   C2  轮次自检：每 `selfCheckEvery` 个用户轮次注入一次「是否在重复失败路径」。
 *       B1 数的是「连续相同调用次数」，C2 数的是「用户轮次」，两者不共用计数器（R3）。
 *
 * 稳定性（hook 不能把 agent 搞崩，R6）：
 *   - 所有监听器内部 try/catch，异常一律降级为「放行 + 记日志」。
 *   - 参数签名与输出 hash 只取前 MAX_HASH_CHARS 个字符，超大输出不会拖死会话。
 *   - 配置非法（0 / 负数 / 非数字）回退默认值并告警（R7）。
 *
 * 相似性只用可计算度量（SHA256），不做语义相似；`*_checkpoint`、`*_directions`、
 * `todo_write` 等记账工具不参与计数。
 */

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const MODE = (() => {
  try {
    return require('./package.json').name === '@local/dsh-proof-preset' ? 'proof' : 'deliberate';
  } catch {
    return 'deliberate';
  }
})();

/** 沿用 memory.cjs 的拒绝码，便于旧日志/新日志统一检索。 */
const DENIAL_CODE = 'REPEATED_IDENTICAL_FAILURE';
const NOTICE_KIND = MODE + 'LoopGuard';
const CHECKPOINT_TOOL = MODE + '_checkpoint';
const DIRECTIONS_TOOL = MODE + '_directions';
const DEFAULT_THRESHOLD = 3;
const DEFAULT_SELF_CHECK_EVERY = 3;
/** 签名/输出 hash 只吃前 8 KB；超出部分不参与比较，也不会被拼接。 */
const MAX_HASH_CHARS = 8192;
const MAX_STATES = 2048;
const MAX_NOTICES = 4;
const MAX_DIRECTIONS = 3;
const MAX_DIRECTION_CHARS = 200;
const LOG_LIMIT = 50;
const SELF_CHECK_INSTRUCTION = '当前做法是否在重复之前失败过的路径？';
const EXCLUDED_TOOLS = new Set([
  CHECKPOINT_TOOL,
  DIRECTIONS_TOOL,
  'proof_checkpoint',
  'deliberate_checkpoint',
  'todo_write',
]);
/** 只影响展示、不改变操作的参数；同一命令换一句 description 不应被当成新策略。 */
const PRESENTATION_KEYS = new Set(['description', 'title', 'summary', 'label']);

const hash = text => createHash('sha256').update(text).digest('hex');
const describe = error => (error instanceof Error ? error.message : String(error));

// ── 日志（异常与配置告警都走这里；写日志本身也不能抛） ──────────────────────

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

// ── 配置校验（R7） ─────────────────────────────────────────────────────────

/**
 * 正整数配置：非法值（0 / 负数 / 非数字 / 小数 / null）回退默认并告警。
 * 数字字符串（YAML 里写成 "3"）按数字接受，避免引号导致静默失效。
 */
function resolvePositiveInt(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(value));
  if (Number.isInteger(number) && number > 0) return number;
  log(`配置 ${name}=${JSON.stringify(value)} 不是正整数，已回退默认值 ${fallback}`);
  return fallback;
}

// ── 签名与输出 hash ────────────────────────────────────────────────────────

/** 只取前 MAX_HASH_CHARS 个字符：超大输出/超长参数不会让 hash 计算变慢。 */
function clamp(text) {
  const value = typeof text === 'string' ? text : String(text);
  return value.length > MAX_HASH_CHARS ? value.slice(0, MAX_HASH_CHARS) : value;
}

/**
 * 工具名 + 参数规范化 SHA256。
 * 顶层去掉 description/title 等展示字段，再对对象键排序；最后整体截断到上限。
 */
function signature(name, args) {
  const cleaned = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.fromEntries(Object.entries(args).filter(([key]) => !PRESENTATION_KEYS.has(key)))
    : args;
  const normalized = JSON.stringify(cleaned, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return hash(name + '\n' + clamp(normalized));
}

/** 输出文本：只取 text 块，累计到上限即停止，避免遍历/拼接超大结果。 */
function outputText(result) {
  const content = result?.content;
  if (typeof content === 'string') return clamp(content);
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  let total = 0;
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
    total += block.text.length;
    if (total >= MAX_HASH_CHARS) break;
  }
  return clamp(parts.join('\n'));
}

/** 输出 hash：状态 + 错误码 + 文本；错误输出沿用 memory.cjs 的判据。 */
function outputKey(result) {
  const failed = result?.isError === true || result?.error !== undefined;
  const code = failed ? String(result?.error?.code ?? '') : '';
  return hash(JSON.stringify([failed ? 'error' : 'ok', code, outputText(result)]));
}

// ── 状态 ───────────────────────────────────────────────────────────────────

function createState() {
  return {
    // B1：连续相同调用
    tool: '',
    signature: '',
    output: '',
    count: 0,
    denials: 0,
    // B1'：连续相同输出（参数不同）
    lastOutput: '',
    outputStreak: 0,
    // C2：轮次自检（与 B1 完全独立的计数器）
    lastTurn: null,
    selfChecks: 0,
    rejectedTurn: null,
    // 通知队列与去重水位
    notices: [],
    shown: 0,
    token: 0,
    // C1：方向记录（会话内保留，不落盘）
    directions: [],
  };
}

function pushNotice(state, notice) {
  // 同一类通知未展示前不重复堆叠，避免一轮里刷出三条一样的提示。
  if (state.notices.some(item => item.reason === notice.reason && item.token > state.shown)) return;
  state.token += 1;
  state.notices.push({ ...notice, token: state.token });
  if (state.notices.length > MAX_NOTICES) state.notices = state.notices.slice(-MAX_NOTICES);
}

// ── 文案 ───────────────────────────────────────────────────────────────────

/** R2：拒绝必须带「换路指令」，不能只给拒绝码。 */
function loopInstruction(count) {
  return `当前做法已连续 ${count} 次相同，请换一个可检验的新策略，并先说明新假设与判定标准。`;
}

/** R8：把已记录的方向带进提示，卡住时先回看再决定是否重想。 */
function directionLines(directions) {
  if (!Array.isArray(directions) || directions.length === 0) return [];
  return [
    '已记录的方向（先回看，别急着重想）：',
    ...directions.map((item, index) => `${index + 1}. ${item}`),
    '先检查这些方向里有没有还没试过、但确实能用的；都不适用再重想。',
  ];
}

function noticeText(reason, count, tool, directions) {
  const lines = [];
  if (reason === 'self') {
    lines.push('[事前自检]', SELF_CHECK_INSTRUCTION,
      '若在重复，先换假设并说明什么观察能区分新旧解释；不要等失败三次才回头。');
  } else if (reason === 'output') {
    lines.push('[运行时防循环]',
      `连续 ${count} 次得到相同输出（调用参数不同），本次调用已执行但没有带来新信息。`,
      loopInstruction(count),
      '不要原样重试。');
  } else {
    lines.push('[运行时防循环]',
      `同一工具、同一参数和同一输出已连续 ${count} 次${tool ? `（${tool}）` : ''}，本次调用未执行。`,
      loopInstruction(count),
      '不要原样重试；若确认是同一阻塞，直接报告阻塞和所需的最小信息。');
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
  const threshold = resolvePositiveInt(config.threshold, DEFAULT_THRESHOLD, 'loop-guard.threshold');
  const selfCheckEvery = resolvePositiveInt(config.selfCheckEvery, DEFAULT_SELF_CHECK_EVERY, 'loop-guard.selfCheckEvery');

  // hostManifest 缺失或解析失败只影响「注入消息」和「方向工具」，不影响拦截本身。
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
      log('加载 @deepseek-ai/dsh-tools 失败，方向记录工具不注册：' + describe(error));
      defineTool = null;
    }
  } else {
    log('缺少 hostManifest，注入消息退化为纯文本消息，方向记录工具不注册');
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

  // C1 方向记录（R8）：会话内维护，不落盘；卡住时会被提示文案引用。
  if (typeof defineTool === 'function' && typeof ctx.tools?.register === 'function') {
    try {
      ctx.tools.register(defineTool({
        name: DIRECTIONS_TOOL,
        description: '记录本轮 2–3 个候选方向（各一句 + 一句利弊），会话内保留；卡住时防循环提示会引用它。不落盘，最多 3 条、每条 200 字符。',
        parameters: {
          action: { type: 'string', enum: ['set', 'read', 'clear'], required: true },
          items: { type: 'array', items: { type: 'string' } },
        },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          if (!exec?.agent) throw new Error('需要当前 Agent 会话');
          const state = stateOf(exec.agent);
          if (args.action === 'read') {
            return state.directions.length
              ? state.directions.map((item, index) => `${index + 1}. ${item}`).join('\n')
              : '当前没有记录方向。';
          }
          if (args.action === 'clear') {
            state.directions = [];
            return '已清除方向记录。';
          }
          if (args.action !== 'set') throw new Error('action 只能是 set / read / clear');
          const items = normalizeDirections(args.items);
          state.directions = items;
          return `已记录 ${items.length} 个方向（会话内保留，卡住时会被引用）。`;
        },
      }));
    } catch (error) {
      log('注册方向记录工具失败，仅保留提示文案：' + describe(error));
    }
  }

  // ── B1：拦截 ────────────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', (exec, next) => {
    let decision = null;
    try {
      if (exec?.agent && !EXCLUDED_TOOLS.has(exec.name)) {
        const state = stateOf(exec.agent);
        const sig = signature(exec.name, exec.arguments);
        if (state.count >= threshold && state.tool === exec.name && state.signature === sig) {
          state.denials += 1;
          pushNotice(state, { reason: 'call', count: state.count, tool: exec.name });
          decision = {
            kind: 'deny',
            reason: noticeText('call', state.count, exec.name, state.directions),
            info: { name: 'ModeLoopGuard', code: DENIAL_CODE },
          };
        }
      }
    } catch (error) {
      // R6：hook 出错一律放行，绝不因为守卫自身异常阻断工具执行。
      log('pre-execute 异常，已放行本次调用：' + describe(error));
      decision = null;
    }
    return decision ?? next();
  });

  // ── B1 / B1'：观察结果 ──────────────────────────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec?.agent || EXCLUDED_TOOLS.has(exec.name)) return;
      // 本 hook 自己的拒绝不计入输出序列，否则会自我强化。
      // 宿主可能把拒绝码放在 error.code，也可能放在 error.info.code，两种都认。
      if (result?.error?.info?.code === DENIAL_CODE || result?.error?.code === DENIAL_CODE) return;
      const state = stateOf(exec.agent);
      // 任何非拒绝的结果都说明模型换了动作，解除“连续撞拦截”的计数。
      state.denials = 0;
      const sig = signature(exec.name, exec.arguments);
      const output = outputKey(result);
      if (state.tool === exec.name && state.signature === sig && state.output === output) {
        state.count += 1;
      } else {
        state.tool = exec.name;
        state.signature = sig;
        state.output = output;
        state.count = 1;
      }
      // 成功但没有任何文本输出的调用（例如静默 write）不参与“输出相同”计数，
      // 否则多次正常写入会被误判成空转；错误输出始终参与。
      const hasText = outputText(result).trim() !== '' || result?.isError === true || result?.error !== undefined;
      if (!hasText) {
        state.lastOutput = '';
        state.outputStreak = 0;
      } else if (output === state.lastOutput) {
        state.outputStreak += 1;
      } else {
        state.lastOutput = output;
        state.outputStreak = 1;
      }
      if (state.count >= threshold) pushNotice(state, { reason: 'call', count: state.count, tool: exec.name });
      else if (state.outputStreak >= threshold) pushNotice(state, { reason: 'output', count: state.outputStreak, tool: exec.name });
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
      const fresh = beginStep(state, payload);
      // 与 memory.cjs 一致：连续两次撞上同一拦截就结束本轮；同一轮只拒绝一次，
      // 避免宿主重复进入 pre-step 时无限拒绝。
      if (state.denials >= 2 && state.rejectedTurn !== payload?.turn) {
        state.rejectedTurn = payload?.turn;
        return { kind: 'reject' };
      }
      if (fresh.length === 0) return decision;
      const messages = fresh.map(notice => makeMessage(noticeText(notice.reason, notice.count, notice.tool, state.directions)));
      return { ...decision, messages: [...(decision.messages ?? []), ...messages] };
    } catch (error) {
      log('pre-step 异常，跳过本次注入：' + describe(error));
      return decision;
    }
  }, { prepend: true });

  ctx.on('agent/disposed', payload => {
    try {
      states.delete(String(payload?.agent?.id ?? ''));
    } catch (error) {
      log('agent/disposed 异常，已忽略：' + describe(error));
    }
  });

  /** C2：轮次计数器（与 B1 的 count 无关）；返回本轮需要注入的通知。 */
  function beginStep(state, payload) {
    if (payload?.turn !== state.lastTurn) {
      state.lastTurn = payload?.turn;
      state.denials = 0;
      state.rejectedTurn = null;
      if (Number.isInteger(payload?.turn) && payload.turn > 0 && payload.turn % selfCheckEvery === 0) {
        state.selfChecks += 1;
        pushNotice(state, { reason: 'self', count: payload.turn, tool: '' });
      }
    }
    const fresh = state.notices.filter(notice => notice.token > state.shown);
    if (fresh.length > 0) {
      state.shown = fresh[fresh.length - 1].token;
      state.notices = state.notices.filter(notice => notice.token > state.shown);
    }
    return fresh;
  }

  function makeMessage(text) {
    const source = { kind: NOTICE_KIND, form: 'snapshot', sections: [{ name: NOTICE_KIND, text }] };
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
  createState,
  noticeText,
  loopInstruction,
  directionLines,
  normalizeDirections,
  resolvePositiveInt,
  clamp,
  logs,
  DENIAL_CODE,
  SELF_CHECK_INSTRUCTION,
  MAX_HASH_CHARS,
  CHECKPOINT_TOOL,
  DIRECTIONS_TOOL,
};
