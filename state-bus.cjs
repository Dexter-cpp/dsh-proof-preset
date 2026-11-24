'use strict';

/**
 * 会话级信号总线：同一 preset 包内 loop-guard.cjs 与 memory.cjs 通过
 * `require('./state-bus.cjs')` 拿到**同一个模块实例**（同目录 → 同缓存），
 * 因此不需要 IPC、不落盘、不联网。
 *
 * 只放"是否发生了新证据 / 目标是否换了版本"这类信号，绝不放参数正文、
 * 断点原文或任何可能含密钥的内容。进程退出即消失；会话销毁时显式 drop。
 */

const MAX_SESSIONS = 2048;

const sessions = new Map();

function keyOf(sessionId) {
  return String(sessionId ?? '');
}

function busFor(sessionId) {
  const key = keyOf(sessionId);
  let entry = sessions.get(key);
  if (!entry) {
    if (sessions.size >= MAX_SESSIONS) {
      // 淘汰最早插入的一条；信号丢失只影响提示时机，不影响正确性。
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
    entry = {
      taskId: key,
      goalRef: null,
      evidenceSeq: 0,
      lastEvidenceAt: 0,
      lastEvidenceKind: '',
      stallEpoch: 0,
      archivedSeq: 0,
      updatedAt: 0,
    };
    sessions.set(key, entry);
  }
  return entry;
}

/** 记录一次目标（宿主 goal 或账本兜底）的当前版本；revision 变化即视为目标变更。 */
function noteGoal(sessionId, goalRef) {
  if (!goalRef || typeof goalRef !== 'object') return null;
  const entry = busFor(sessionId);
  const revision = Number(goalRef.revision);
  const id = goalRef.id === undefined || goalRef.id === null ? '' : String(goalRef.id);
  if (!Number.isFinite(revision) || revision < 0) return entry.goalRef;
  const changed = !entry.goalRef || entry.goalRef.id !== id || entry.goalRef.revision !== revision;
  entry.goalRef = { id, revision };
  entry.updatedAt = Date.now();
  if (changed) entry.stallEpoch += 1;
  return entry.goalRef;
}

/** 记录一次新证据（假设状态变化、断点保存、反例登记都算）。 */
function noteEvidence(sessionId, meta = {}) {
  const entry = busFor(sessionId);
  entry.evidenceSeq += 1;
  entry.lastEvidenceAt = Date.now();
  entry.lastEvidenceKind = typeof meta.kind === 'string' ? meta.kind.slice(0, 32) : 'unknown';
  entry.updatedAt = entry.lastEvidenceAt;
  return entry.evidenceSeq;
}

function noteArchived(sessionId) {
  const entry = busFor(sessionId);
  entry.archivedSeq += 1;
  entry.updatedAt = Date.now();
  return entry.archivedSeq;
}

function setTask(sessionId, taskId) {
  const entry = busFor(sessionId);
  const value = String(taskId ?? '').trim();
  if (value) entry.taskId = value.slice(0, 64);
  return entry.taskId;
}

/** 只读快照：调用方不得修改返回值。 */
function snapshot(sessionId) {
  const entry = busFor(sessionId);
  return {
    taskId: entry.taskId,
    goalRef: entry.goalRef ? { ...entry.goalRef } : null,
    evidenceSeq: entry.evidenceSeq,
    lastEvidenceAt: entry.lastEvidenceAt,
    lastEvidenceKind: entry.lastEvidenceKind,
    stallEpoch: entry.stallEpoch,
    archivedSeq: entry.archivedSeq,
  };
}

function drop(sessionId) {
  sessions.delete(keyOf(sessionId));
}

function reset() {
  sessions.clear();
}

exports.busFor = busFor;
exports.noteGoal = noteGoal;
exports.noteEvidence = noteEvidence;
exports.noteArchived = noteArchived;
exports.setTask = setTask;
exports.snapshot = snapshot;
exports.drop = drop;
exports.reset = reset;
exports._size = () => sessions.size;
