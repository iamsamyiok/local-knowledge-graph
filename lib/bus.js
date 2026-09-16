'use strict';

// 极简进程内事件总线：图谱变更通知（SSE 推送用）

const listeners = new Set();

function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, payload) {
  for (const fn of listeners) {
    try { fn(type, payload); } catch (_) { /* 单监听器异常不影响其余 */ }
  }
}

module.exports = { on, emit, count: () => listeners.size };
