'use strict';

/**
 * 镜像「空降级」守卫测试（推送路径 + 槽位时间戳）。
 *
 * 背景（真机症状：侧边栏项目/对话整树消失、只有下拉刷新能恢复）：
 *  1) `installMirror` 是隧道推送（T.sync）与磁盘兜底共用的整份替换入口，此前**没有任何
 *     空清单保护**：宿主推来一份空清单（回归 / 版本错配 / 第三方 instance）就会把手机侧
 *     的非空镜像顶掉，而中转无法区分它与「真清空」；
 *  2) `mirrorSlotAt` 对无记录的槽位回退 `inst.mirrorAt`，而 `markMirrorSlot` 每刷新一个
 *     槽位就前移它 —— 「从没收到过这个槽位」会被报成刚刚更新，空降级宽限判定虚高。
 *
 * 逃生口与宿主契约：宿主只在**确实读到合法空**时写 `emptyConfirmed: true`
 * （dsh-mobile-plugin/lib/mobile/sessions.js:281、lib/mobile/workspaces.js:78），
 * 中转据此放行真清空；`tunnel-handler.js` 的 `mirrorBody` 必须原样保留这个字段。
 *
 * 运行：node test/mirror-empty-guard.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  installMirror,
  mirrorSlotAt,
  markMirrorSlot,
  SLOT_SESSIONS,
  SLOT_WORKSPACES,
  SLOT_MODELS,
  SLOT_STATS,
} = require('../lib/mirror-state.js');

const nonEmpty = (id) => ({ ok: true, items: [{ id }], emptyConfirmed: false });
const confirmedEmpty = () => ({ ok: true, items: [], emptyConfirmed: true });
const unconfirmedEmpty = () => ({ ok: true, items: [] });

function fakeInst(instanceId = 'inst-empty') {
  return { instanceId, pending: new Map(), mirror: null, mirrorAt: 0, mirrorSlotAt: null };
}

/** 抓日志：拒绝必须留痕，否则「手机一直读旧镜像」在两侧都查不到线索。 */
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test('未确认的空推送不得覆盖非空清单，且被拒槽位的时间戳不得前移', () => {
  const inst = fakeInst();
  const at = 1_000_000;
  installMirror(inst, { sessions: nonEmpty('keep'), workspaces: nonEmpty('ws-keep') }, at);
  assert.deepEqual(inst.mirror.sessions.items, [{ id: 'keep' }]);
  assert.equal(mirrorSlotAt(inst, SLOT_SESSIONS), at);

  const lines = captureLog(() => {
    installMirror(inst, { sessions: unconfirmedEmpty(), workspaces: unconfirmedEmpty() }, at + 5_000);
  });

  assert.deepEqual(inst.mirror.sessions.items, [{ id: 'keep' }], '未确认的空清单必须被拒（保留上一份非空）');
  assert.deepEqual(inst.mirror.workspaces.items, [{ id: 'ws-keep' }], 'workspaces 同样受保护');
  assert.equal(mirrorSlotAt(inst, SLOT_SESSIONS), at, '内容没换，时间戳就不能前移（否则旧清单被伪装成刚推来）');
  assert.ok(lines.some((l) => l.includes('mirror empty overwrite rejected')), '拒绝必须记日志');
});

test('emptyConfirmed:true 的真清空必须放行', () => {
  const inst = fakeInst();
  installMirror(inst, { sessions: nonEmpty('keep'), workspaces: nonEmpty('ws-keep') }, 2_000);
  installMirror(inst, { sessions: confirmedEmpty(), workspaces: confirmedEmpty() }, 9_000);
  assert.deepEqual(inst.mirror.sessions.items, [], '宿主显式确认的空清单是合法删除，不能被守卫困住');
  assert.deepEqual(inst.mirror.workspaces.items, []);
  assert.equal(mirrorSlotAt(inst, SLOT_SESSIONS), 9_000, '放行的槽位要正常前移');
});

test('首次空推送（没有非空前值）必须放行 —— 磁盘兜底与冷启动都走这条路', () => {
  const inst = fakeInst();
  installMirror(inst, { sessions: unconfirmedEmpty() }, 500);
  assert.deepEqual(inst.mirror.sessions.items, []);
  assert.equal(mirrorSlotAt(inst, SLOT_SESSIONS), 500);
});

test('messages/stats 的空 body 不受该守卫影响（它们不是清单槽位）', () => {
  const inst = fakeInst();
  installMirror(inst, {
    sessions: nonEmpty('a'),
    messages: { s1: { ok: true, items: [{ seq: 1 }] } },
  }, 700);
  installMirror(inst, {
    sessions: nonEmpty('a'),
    messages: { s1: { ok: true, items: [] } },
  }, 900);
  assert.deepEqual(inst.mirror.messages.s1.items, [], '「这个会话还没有消息」不能被当成空降级');
});

test('mirrorSlotAt 不回退 inst.mirrorAt：没有记录就是 0', () => {
  assert.equal(mirrorSlotAt({ mirrorAt: 12_345, mirrorSlotAt: null }, SLOT_SESSIONS), 0,
    '没有槽位表时不得回退整份镜像时间');

  const inst = fakeInst();
  installMirror(inst, { sessions: nonEmpty('x'), workspaces: nonEmpty('y') }, 2_000);
  assert.equal(mirrorSlotAt(inst, SLOT_MODELS), 2_000);
  markMirrorSlot(inst, SLOT_SESSIONS, undefined, 9_000);
  assert.equal(mirrorSlotAt(inst, SLOT_MODELS), 2_000, '刷新一个槽位不得把别的槽位带着前移');
  assert.equal(mirrorSlotAt(inst, SLOT_STATS, undefined), 0, '整表缺失的槽位不得回退 inst.mirrorAt');
  assert.equal(mirrorSlotAt(inst, 'messages', 'missing-session'), 0, '没有该 session 的记录就是 0');
});

test('源码契约：installMirror 必须过空降级守卫，且谓词与宿主契约同口径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mirror-state.js'), 'utf8');
  assert.match(src, /rejectUnconfirmedEmpty\(mirror, previous\)/, 'installMirror 必须调用守卫');
  assert.match(src, /incoming\.emptyConfirmed === true/, '放行条件必须是显式确认（与 server.js 的谓词同口径）');
  assert.equal(/const fallback = Number\(inst\.mirrorAt\)/.test(src), false, '不得再回退 inst.mirrorAt');
});
