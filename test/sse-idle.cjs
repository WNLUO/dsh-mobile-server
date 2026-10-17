'use strict';

/**
 * 回归：relay 侧对已 start 的 SSE 没有任何空闲哨兵。
 *
 * 现场（Defect D）：插件写完 `: connected` 之后既不产出也不终止，relay 条目就一直
 * 挂在 `inst.pending` 里、`res` 永不 end，客户端要等自己的超时才断（实测挂了 600s）。
 * 而 `T.httpEnd`（tunnel-handler.js）在 `!entry` 时直接 return —— 条目一旦不在，
 * relay 手里连 `res` 都没有，根本没法收尾。
 *
 * `armSseIdle` 在 `T.httpHead` 后武装、每个 `T.httpChunk` 重置；超过阈值一个字节都
 * 没有就主动 end + 通知上游取消，把「无限期静默挂死」降级成一次可自愈的重连。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { armSseIdle } = require('../lib/proxy-http.js');
const { T } = require('../lib/protocol.js');

/** 可手动触发的 setTimeout/clearTimeout 桩。 */
function fakeTimers() {
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; };
  global.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
  return {
    timers,
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
  };
}

function fakeInstance() {
  const frames = [];
  return {
    instanceId: 'inst-1',
    pending: new Map(),
    nextId: 0,
    frames,
    ws: { readyState: 1, bufferedAmount: 0, send: (frame) => frames.push(frame) },
  };
}

function fakeEntry(overrides = {}) {
  return {
    kind: 'http',
    sse: true,
    cancelled: false,
    started: true,
    idleTimer: null,
    res: { ended: false, end() { this.ended = true; } },
    ...overrides,
  };
}

test('non-SSE entries are left alone', () => {
  const timers = fakeTimers();
  try {
    const inst = fakeInstance();
    const entry = fakeEntry({ sse: false });
    armSseIdle(inst, 1, entry);
    assert.equal(timers.timers.length, 0);
    assert.equal(entry.idleTimer, null);
  } finally { timers.restore(); }
});

test('each chunk re-arms the sentinel (clear old, set new)', () => {
  const timers = fakeTimers();
  try {
    const inst = fakeInstance();
    const entry = fakeEntry();
    armSseIdle(inst, 1, entry);
    const first = entry.idleTimer;
    armSseIdle(inst, 1, entry);
    assert.equal(timers.timers.length, 2);
    assert.equal(first.cleared, true, '重置必须清掉上一个定时器');
    assert.notEqual(entry.idleTimer, first);
    assert.equal(entry.idleTimer.ms, 30_000, '阈值必须明显大于插件 15s 的 keepalive');
  } finally { timers.restore(); }
});

test('idle timeout ends the response, drops the entry and cancels upstream', () => {
  const timers = fakeTimers();
  try {
    const inst = fakeInstance();
    const entry = fakeEntry();
    inst.pending.set(7, entry);
    armSseIdle(inst, 7, entry);
    entry.idleTimer.fn();

    assert.equal(entry.res.ended, true, '超时必须结束响应，否则客户端静默挂死');
    assert.equal(inst.pending.has(7), false, '超时后条目必须从 pending 摘掉');
    assert.equal(inst.frames.length, 1, '必须通知上游取消');
    assert.equal(inst.frames[0][0], T.httpCancel);
  } finally { timers.restore(); }
});

test('a reaped entry is not reaped twice', () => {
  const timers = fakeTimers();
  try {
    const inst = fakeInstance();
    const entry = fakeEntry();
    inst.pending.set(7, entry);
    armSseIdle(inst, 7, entry);
    const armed = entry.idleTimer;
    armed.fn();
    armed.fn(); // 同一个定时器被重复触发（防御）
    assert.equal(inst.frames.length, 1);
  } finally { timers.restore(); }
});

test('a cancelled or replaced entry is never reaped', () => {
  const timers = fakeTimers();
  try {
    // 客户端已断开 → cancel() 置 cancelled 并删条目。
    const instA = fakeInstance();
    const entryA = fakeEntry({ cancelled: true });
    armSseIdle(instA, 7, entryA);
    entryA.idleTimer.fn();
    assert.equal(entryA.res.ended, false);
    assert.equal(instA.frames.length, 0);

    // 条目已被 httpEnd 摘掉 → 不能再碰它（同 id 可能已被新请求复用）。
    const instB = fakeInstance();
    const entryB = fakeEntry();
    armSseIdle(instB, 7, entryB);
    instB.pending.delete(7);
    entryB.idleTimer.fn();
    assert.equal(entryB.res.ended, false);
    assert.equal(instB.frames.length, 0);
  } finally { timers.restore(); }
});

test('tunnel-handler wires the sentinel on head/chunk and clears it on end/error', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel-handler.js'), 'utf8');
  assert.ok(source.includes('armSseIdle'), 'tunnel-handler 必须引入 armSseIdle');
  assert.ok(
    /entry\.res\.writeHead\(msg\.status \|\| 502, sanitizeRespHeaders\(msg\.headers\)\);\s*\n\s*armSseIdle\(tunnel, id, entry\);/.test(source),
    'T.httpHead 必须武装哨兵',
  );
  assert.ok(
    /const writable = entry\.res\.write\(payload\);\s*\n\s*armSseIdle\(tunnel, id, entry\);/.test(source),
    'T.httpChunk 必须重置哨兵',
  );
  assert.equal(
    (source.match(/if \(entry\.idleTimer\) clearTimeout\(entry\.idleTimer\);/g) || []).length,
    3,
    'T.httpEnd、T.httpError 与隧道断开（failAllPending）都必须清掉哨兵',
  );
});
