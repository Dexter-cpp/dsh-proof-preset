'use strict';

/**
 * 结构化假设账本（纯逻辑，无插件依赖）。
 *
 * 设计约束：
 * - 状态只有 untested / testing / supported / falsified / blocked 五态，另有
 *   `archived` 标记（不是状态），避免"归档"污染状态机。
 * - 状态只能由证据改变：supported 需要有效且非自证的证据；falsified 需要反例/矛盾。
 * - falsified 是终态：不能改名重开，只能新建一条并标 supersedes。
 * - 所有字段有数量/长度/总大小上限，超限直接报错且不改变原状态。
 */

const { createHash } = require('node:crypto');

const STATUSES = ['untested', 'testing', 'supported', 'falsified', 'blocked'];
const AXES = ['model', 'algorithm', 'data', 'verification', 'direction', 'other'];
const RISKS = ['low', 'medium', 'high'];
const CONFIDENCE = ['unverified', 'partial', 'strict'];
const EVIDENCE_KINDS = ['test', 'checker', 'proof', 'observation', 'review', 'self'];
const VALIDITY = ['valid', 'invalid'];

/** 合法状态迁移；falsified 不在任何 key 里 —— 它是终态。 */
const TRANSITIONS = {
  // untested 允许直接带着证据进入 supported/falsified：一次调用就记录"命题 + 结论"是常见用法，
  // 但仍要过证据校验，不能凭信心跳档。
  untested: ['testing', 'supported', 'falsified', 'blocked'],
  testing: ['supported', 'falsified', 'blocked', 'untested'],
  supported: ['testing', 'blocked'],
  blocked: ['testing', 'untested'],
  falsified: [],
};

const DEFAULT_LIMITS = {
  maxHypotheses: 20,
  maxStatementChars: 240,
  maxEvidencePerHypothesis: 5,
  maxStateBytes: 8192,
  maxEvidenceChars: 200,
  maxNextCheckChars: 200,
};

let limits = { ...DEFAULT_LIMITS };

function configure(next = {}) {
  limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = Number(next[key]);
    if (Number.isInteger(value) && value > 0) limits[key] = value;
  }
  return { ...limits };
}

const stores = new Map();
const MAX_STORES = 2048;

function storeOf(sessionId) {
  const key = String(sessionId ?? '');
  let store = stores.get(key);
  if (!store) {
    if (stores.size >= MAX_STORES) stores.delete(stores.keys().next().value);
    store = { items: new Map(), order: [], nextId: 1 };
    stores.set(key, store);
  }
  return store;
}

function drop(sessionId) {
  stores.delete(String(sessionId ?? ''));
}

/** 仅测试与进程清理使用：清空全部会话账本。 */
function reset() {
  stores.clear();
}

/** 规范化命题文本，用于识别"同一句话改个名字重开"。 */
function fingerprint(statement) {
  const text = String(statement ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。．.！!？?；;，,、"'“”‘’()（）\[\]【】]/g, '');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function clip(text, max) {
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

function assertEnum(value, allowed, name) {
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value)) throw new Error(`${name} 只能是 ${allowed.join(' / ')}`);
  return value;
}

function normalizeEvidence(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('evidence 需要数组');
  if (list.length > limits.maxEvidencePerHypothesis) {
    throw new Error(`每条假设最多 ${limits.maxEvidencePerHypothesis} 条证据`);
  }
  return list.map(item => {
    if (!item || typeof item !== 'object') throw new Error('evidence 每项需要对象');
    const kind = assertEnum(item.kind, EVIDENCE_KINDS, 'evidence.kind') ?? 'observation';
    const validity = assertEnum(item.validity, VALIDITY, 'evidence.validity') ?? 'valid';
    const source = clip(item.source, limits.maxEvidenceChars);
    const result = clip(item.result, limits.maxEvidenceChars);
    if (!source && !result) throw new Error('evidence 需要 source 或 result');
    return { kind, validity, source, result, at: new Date().toISOString() };
  });
}

function totalBytes(store) {
  return JSON.stringify([...store.items.values()]).length;
}

function checkBudget(store, candidate) {
  const bytes = JSON.stringify([...store.items.values(), candidate]).length;
  if (bytes > limits.maxStateBytes) {
    throw new Error(`假设账本超过 ${limits.maxStateBytes} 字节上限，请先归档或精简`);
  }
}

function publicItem(item) {
  return { ...item, evidence: item.evidence.map(entry => ({ ...entry })) };
}

function validateConclusion(item) {
  if (item.status === 'testing' && item.risk === 'high' && !item.nextCheck) {
    throw new Error('高风险假设进入 testing 前必须写 nextCheck');
  }
  if (item.status !== 'supported' && item.status !== 'falsified') return;
  if (item.evidence.some(entry => entry.validity === 'valid' && entry.kind !== 'self' && entry.result)) return;
  throw new Error(item.status === 'supported'
    ? 'supported 需要至少一条有效且非自证的证据，并写明观察结果'
    : 'falsified 需要反例/实验/矛盾证据，并写明观察结果');
}

function set(sessionId, input = {}) {
  const store = storeOf(sessionId);
  const statement = clip(input.statement, limits.maxStatementChars);
  if (!statement) throw new Error('statement 必填（≤' + limits.maxStatementChars + ' 字符）');
  const live = [...store.items.values()].filter(item => !item.archived);
  if (live.length >= limits.maxHypotheses) {
    throw new Error(`最多 ${limits.maxHypotheses} 条未归档假设，请先归档`);
  }
  const id = input.id ? String(input.id).trim() : 'H' + store.nextId;
  if (!/^H[0-9]{1,2}$/.test(id)) throw new Error('id 形如 H1…H99');
  if (store.items.has(id)) throw new Error(`假设 ${id} 已存在，用 update 修改`);
  const status = assertEnum(input.status, STATUSES, 'status') ?? 'untested';
  if (status === 'falsified') throw new Error('新建假设不能直接是 falsified，请先记录再更新');
  const risk = assertEnum(input.risk, RISKS, 'risk') ?? 'medium';
  const axis = assertEnum(input.axis, AXES, 'axis') ?? 'other';
  const nextCheck = clip(input.nextCheck, limits.maxNextCheckChars);
  const item = {
    id,
    taskId: String(input.taskId ?? '').slice(0, 64),
    statement,
    fingerprint: fingerprint(statement),
    status,
    risk,
    axis,
    nextCheck,
    expect: input.expect && typeof input.expect === 'object'
      ? {
        ifSupport: clip(input.expect.ifSupport, 120),
        ifRefute: clip(input.expect.ifRefute, 120),
        invalidIf: clip(input.expect.invalidIf, 120),
      }
      : null,
    confidence: assertEnum(input.confidence, CONFIDENCE, 'confidence') ?? 'unverified',
    evidence: normalizeEvidence(input.evidence),
    supersedes: input.supersedes ? String(input.supersedes).trim().slice(0, 8) : null,
    archived: false,
    archiveReason: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  validateConclusion(item);
  checkBudget(store, item);
  store.items.set(id, item);
  store.order.push(id);
  store.nextId = Math.max(store.nextId, Number(id.slice(1)) + 1);
  return publicItem(item);
}

function get(sessionId, id) {
  const store = storeOf(sessionId);
  const item = store.items.get(String(id));
  if (!item) throw new Error(`没有假设 ${id}`);
  return item;
}

function update(sessionId, id, patch = {}) {
  const store = storeOf(sessionId);
  const item = get(sessionId, id);
  if (item.archived) throw new Error(`假设 ${id} 已归档，不能修改`);
  const next = publicItem(item);
  if (patch.statement !== undefined) {
    const statement = clip(patch.statement, limits.maxStatementChars);
    if (!statement) throw new Error('statement 不能为空');
    next.statement = statement;
    next.fingerprint = fingerprint(statement);
    if (next.fingerprint !== item.fingerprint && ['supported', 'falsified'].includes(item.status)) {
      throw new Error('修改已有结论的命题请新建假设，并用 supersedes 关联原命题');
    }
  }
  if (patch.nextCheck !== undefined) next.nextCheck = clip(patch.nextCheck, limits.maxNextCheckChars);
  if (patch.risk !== undefined) next.risk = assertEnum(patch.risk, RISKS, 'risk');
  if (patch.axis !== undefined) next.axis = assertEnum(patch.axis, AXES, 'axis');
  if (patch.confidence !== undefined) next.confidence = assertEnum(patch.confidence, CONFIDENCE, 'confidence');
  if (patch.evidence !== undefined) next.evidence = normalizeEvidence(patch.evidence);

  if (patch.status !== undefined && patch.status !== item.status) {
    const target = assertEnum(patch.status, STATUSES, 'status');
    const allowed = TRANSITIONS[item.status] ?? [];
    if (!allowed.includes(target)) {
      throw new Error(
        item.status === 'falsified'
          ? 'falsified 是终态：不能改状态；请新建一条并用 supersedes 关联原假设'
          : `不允许 ${item.status} → ${target}；合法目标：${allowed.join(' / ') || '无'}`
      );
    }
    next.status = target;
  }

  validateConclusion(next);
  next.updatedAt = new Date().toISOString();
  checkBudget(store, next);
  store.items.set(next.id, next);
  return publicItem(next);
}

function archive(sessionId, id, reason = '') {
  const store = storeOf(sessionId);
  const item = get(sessionId, id);
  const next = { ...item, archived: true, archiveReason: clip(reason, 80), updatedAt: new Date().toISOString() };
  store.items.set(next.id, next);
  return publicItem(next);
}

function archiveAll(sessionId, reason = '') {
  const store = storeOf(sessionId);
  let count = 0;
  for (const [id, item] of store.items) {
    if (item.archived) continue;
    store.items.set(id, { ...item, archived: true, archiveReason: clip(reason, 80), updatedAt: new Date().toISOString() });
    count += 1;
  }
  return count;
}

function reopen(sessionId, id, evidence) {
  const item = get(sessionId, id);
  if (item.status === 'falsified') {
    throw new Error('falsified 不能重开；请新建假设并标 supersedes');
  }
  if (item.archived) throw new Error('已归档的假设不能重开');
  const patch = { status: 'testing' };
  if (evidence !== undefined) patch.evidence = [...item.evidence, ...normalizeEvidence([evidence])];
  return update(sessionId, id, patch);
}

function list(sessionId, options = {}) {
  const store = storeOf(sessionId);
  const includeArchived = options.includeArchived === true;
  return store.order
    .map(id => store.items.get(id))
    .filter(item => item && (includeArchived || !item.archived))
    .map(publicItem);
}

function view(sessionId, options = {}) {
  const items = list(sessionId, options);
  if (items.length === 0) return '当前没有记录假设。';
  return items
    .map(item => {
      const head = `${item.id} [${item.status}]${item.archived ? '[archived]' : ''} ${item.statement}`;
      const meta = [
        item.axis !== 'other' ? item.axis : '',
        item.risk === 'high' ? 'high-risk' : '',
        item.nextCheck ? 'next: ' + item.nextCheck : '',
        item.evidence.length ? `evidence×${item.evidence.length}` : '',
        item.supersedes ? 'supersedes ' + item.supersedes : '',
      ].filter(Boolean);
      return meta.length ? `${head}（${meta.join('；')}）` : head;
    })
    .join('\n');
}

function stats(sessionId) {
  const store = storeOf(sessionId);
  const byStatus = {};
  let archived = 0;
  for (const item of store.items.values()) {
    if (item.archived) { archived += 1; continue; }
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  }
  return { total: store.items.size, archived, byStatus, bytes: totalBytes(store) };
}

/** 已证伪命题的指纹集合：新建同义假设时用于提示（不阻止，只标注）。 */
function falsifiedFingerprints(sessionId) {
  const store = storeOf(sessionId);
  const set = new Set();
  for (const item of store.items.values()) {
    if (item.status === 'falsified') set.add(item.fingerprint);
  }
  return set;
}

exports.STATUSES = STATUSES;
exports.TRANSITIONS = TRANSITIONS;
exports.AXES = AXES;
exports.configure = configure;
exports.limits = () => ({ ...limits });
exports.fingerprint = fingerprint;
exports.set = set;
exports.get = get;
exports.update = update;
exports.archive = archive;
exports.archiveAll = archiveAll;
exports.reopen = reopen;
exports.list = list;
exports.view = view;
exports.stats = stats;
exports.falsifiedFingerprints = falsifiedFingerprints;
exports.drop = drop;
exports.reset = reset;
exports._storeOf = storeOf;
