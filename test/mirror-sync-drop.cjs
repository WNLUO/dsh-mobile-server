'use strict';

/**
 * 镜像推送（T.sync）失败可见性守卫测试。
 *
 * 背景：`T.sync` 是**单向帧**，协议里没有 syncAck —— 宿主只要隧道写得进去就认为推送成功，
 * `mirror.ok` 保持为真。清洗失败（载荷形状不对、超过 MAX_MIRROR_BYTES）此前没有 else 分支：
 * 无日志、无计数、无重试，于是「宿主说推了 / 手机一直读到旧镜像」这种故障在两侧都查不到
 * 线索。现在必须留下结构化日志与计数（mirrorSyncStats），并且**绝不能**用一份坏载荷把
 * 已有镜像整份替换成空壳。
 *
 * 运行：node test/mirror-sync-drop.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// saveMirrorToDisk 的目标目录在 require 时读取，必须在 require 之前设好，别污染仓内 data/。
process.env.MIRROR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sync-drop-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleTunnelFrame, mirrorSyncStats, sanitizeMirrorDetailed } = require('../lib/tunnel-handler.js');
const { T } = require('../lib/protocol.js');

// 注意：payload 是帧里那段 JSON 原文，不是 encodeFrame 出来的整帧（那是 fake-desktop 用的）。
const syncFrame = (obj) => ({ type: T.sync, id: 0, payload: Buffer.from(JSON.stringify(obj), 'utf8') });

function fakeInst(instanceId = 'sync-1') {
  return { instanceId, pending: new Map(), mirror: null, mirrorAt: 0, mirrorSlotAt: null };
}
const good = (id) => ({ ok: true, items: [{ id }] });

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}
const stats = () => ({ ...mirrorSyncStats });

test('sanitizeMirrorDetailed 给出可定位的丢弃原因', () => {
  assert.deepEqual(sanitizeMirrorDetailed(undefined), { mirror: null, reason: 'not-an-object' });
  assert.deepEqual(sanitizeMirrorDetailed(null), { mirror: null, reason: 'not-an-object' });
  assert.deepEqual(sanitizeMirrorDetailed('nope'), { mirror: null, reason: 'not-an-object' });
  assert.deepEqual(sanitizeMirrorDetailed([1, 2]), { mirror: null, reason: 'not-an-object' });
  // parseJson 失败返回的就是 {} —— 照常 install 会把已有镜像替换成空壳。
  assert.equal(sanitizeMirrorDetailed({}).reason, 'no-mirror-slots');
  assert.equal(sanitizeMirrorDetailed({ unrelated: true }).reason, 'no-mirror-slots');

  const ok = sanitizeMirrorDetailed({ sessions: good('a') });
  assert.equal(ok.reason, '');
  assert.deepEqual(ok.mirror.sessions.items, [{ id: 'a' }]);
});

test('mirrorBody 必须原样保留 emptyConfirmed（空降级守卫的逃生口）', () => {
  const confirmed = sanitizeMirrorDetailed({ sessions: { ok: true, items: [], emptyConfirmed: true } });
  assert.equal(confirmed.mirror.sessions.emptyConfirmed, true,
    '这个字段被清洗掉，中转就无法区分「真清空」与「抖动回空」');
  const notConfirmed = sanitizeMirrorDetailed({ sessions: { ok: true, items: [], emptyConfirmed: false } });
  assert.equal(notConfirmed.mirror.sessions.emptyConfirmed, false);
});

test('T.sync 超限载荷：计数 + 日志 + 不动已有镜像', () => {
  const inst = fakeInst();
  handleTunnelFrame(inst, syncFrame({ sessions: good('keep') }));
  const before = stats();
  assert.deepEqual(inst.mirror.sessions.items, [{ id: 'keep' }]);

  const huge = { sessions: { ok: true, items: Array.from({ length: 5_000 }, (_, i) => ({ id: 's' + i, title: 'x'.repeat(1024) })) } };
  const lines = captureLog(() => {
    handleTunnelFrame(inst, syncFrame(huge));
  });

  const after = stats();
  assert.equal(after.dropped, before.dropped + 1, '丢弃必须计数');
  assert.equal(after.lastDropReason, 'over-max-bytes');
  assert.ok(after.lastDroppedBytes > 4 * 1024 * 1024, '要记下原始大小，便于判断是宿主推大了还是被截断了');
  assert.ok(lines.some((l) => l.includes('mirror sync dropped') && l.includes('over-max-bytes')), '必须记日志');
  assert.deepEqual(inst.mirror.sessions.items, [{ id: 'keep' }], '坏载荷不得把已有镜像顶掉');
});

test('T.sync 形状不对（parseJson 失败 → {}）：计数 + 日志 + 不动已有镜像', () => {
  const inst = fakeInst();
  handleTunnelFrame(inst, syncFrame({ workspaces: good('ws-keep') }));
  const before = stats();
  assert.deepEqual(inst.mirror.workspaces.items, [{ id: 'ws-keep' }]);

  const lines = captureLog(() => {
    handleTunnelFrame(inst, { type: T.sync, id: 0, payload: Buffer.from('{not json', 'utf8') });
  });

  const after = stats();
  assert.equal(after.dropped, before.dropped + 1);
  assert.equal(after.lastDropReason, 'no-mirror-slots');
  assert.ok(lines.some((l) => l.includes('mirror sync dropped')), '必须记日志');
  assert.deepEqual(inst.mirror.workspaces.items, [{ id: 'ws-keep' }], '空壳不得覆盖已有镜像');
});

test('T.sync 正常载荷：计数 accepted 并落盘', async () => {
  const inst = fakeInst('sync-disk');
  const before = stats();
  handleTunnelFrame(inst, syncFrame({ sessions: good('ok-1') }));
  assert.equal(stats().accepted, before.accepted + 1);
  assert.equal(stats().dropped, before.dropped, '正常载荷不得被算成丢弃');
  assert.deepEqual(inst.mirror.sessions.items, [{ id: 'ok-1' }]);

  const file = path.join(process.env.MIRROR_DATA_DIR, 'mirror-sync-disk.json');
  for (let i = 0; i < 50 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(file), '正常推送仍要异步落盘（磁盘兜底）');
});

test('源码契约：case T.sync 不得再是静默丢弃', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tunnel-handler.js'), 'utf8');
  assert.match(src, /sanitizeMirrorDetailed\(msg\)/);
  assert.match(src, /mirrorSyncStats\.dropped \+= 1/);
  assert.match(src, /mirror sync dropped:/);
});
