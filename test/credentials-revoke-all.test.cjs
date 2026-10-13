'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 用临时文件隔离设备凭据存储，避免污染真实 ~/.dsh。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const { T, encodeFrame } = require('../lib/protocol.js');
const { handleTunnelFrame } = require('../lib/tunnel-handler.js');

test('revokeAllByInstance revokes every live credential of an instance and keeps others', () => {
  const a1 = credentials.issue('inst-a', { deviceId: 'dev-1' }, 'tok-1');
  const a2 = credentials.issue('inst-a', { deviceId: 'dev-2' }, 'tok-2');
  const b1 = credentials.issue('inst-b', { deviceId: 'dev-9' }, 'tok-9');

  assert.ok(credentials.find(a1.credential, 'inst-a'));
  assert.ok(credentials.find(a2.credential, 'inst-a'));
  assert.ok(credentials.find(b1.credential, 'inst-b'));

  const revoked = credentials.revokeAllByInstance('inst-a');
  assert.equal(revoked, 2);

  assert.equal(credentials.find(a1.credential, 'inst-a'), null);
  assert.equal(credentials.find(a2.credential, 'inst-a'), null);
  assert.ok(credentials.find(b1.credential, 'inst-b'));
  assert.equal(credentials.listActive().filter((x) => x.instanceId === 'inst-a').length, 0);
});

test('revokeAllByInstance is a no-op for an unknown instance', () => {
  const b1 = credentials.issue('inst-b', { deviceId: 'dev-10' }, 'tok-10');
  const revoked = credentials.revokeAllByInstance('inst-zzz');
  assert.equal(revoked, 0);
  assert.ok(credentials.find(b1.credential, 'inst-b'));
});

test('tunnel T.revokeAll purges credentials and replies with revokeAllAck', () => {
  const a3 = credentials.issue('inst-c', { deviceId: 'dev-3' }, 'tok-3');
  let captured = null;
  const inst = {
    instanceId: 'inst-c',
    pending: new Map(),
    pendingPairs: new Map(),
    tunnel: {
      send(buf) { captured = buf; },
      close() {},
    },
  };

  handleTunnelFrame(inst, { type: T.revokeAll, id: 0, payload: Buffer.alloc(0) });

  assert.ok(captured, 'expected an ack frame');
  assert.equal(captured.readUInt8(0), T.revokeAllAck);
  const payload = JSON.parse(captured.subarray(9).toString('utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.revoked, 1);
  assert.equal(credentials.find(a3.credential, 'inst-c'), null);
});

test('revokeAllAck encoder round-trips through encodeFrame', () => {
  const frame = encodeFrame(T.revokeAllAck, 0, { ok: true, revoked: 3 });
  assert.equal(frame.readUInt8(0), T.revokeAllAck);
});

// `find` 回答「这个调用者可以继续吗」，`lookup` 回答「这张凭据是我们签发的吗」。
// 宿主与中转各自持有独立的凭据库，所以调用方必须能区分这两种「查不到」：
// 本地签发但已吊销 → 立即拒绝；本地从未签发（中转签发）→ 回退到无状态令牌。
test('lookup 能区分「本机已吊销」与「本机从未签发」', () => {
  const issued = credentials.issue('inst-lookup', { deviceId: 'dev-lookup' }, 'tok-lookup');
  assert.ok(credentials.isLive(credentials.lookup(issued.credential, 'inst-lookup')), '新签发应为有效');

  assert.ok(credentials.revoke(issued.credential, 'inst-lookup'), '吊销应成功');
  assert.equal(credentials.find(issued.credential, 'inst-lookup'), null, 'find 必须看不到已吊销凭据');
  const record = credentials.lookup(issued.credential, 'inst-lookup');
  assert.ok(record, 'lookup 必须仍能找到已吊销凭据，否则无法区分「已吊销」与「别人的」');
  assert.equal(credentials.isLive(record), false, '已吊销凭据不得判为有效');

  const foreign = `dshc_${Buffer.from('issued-by-another-store').toString('base64url')}`;
  assert.equal(credentials.lookup(foreign, 'inst-lookup'), null, '本机从未签发的凭据 lookup 必须为 null');
  assert.equal(credentials.lookup(issued.credential, 'inst-other'), null, 'instanceId 不匹配时不得命中');
});

test('过期凭据同样被 find 剔除、被 lookup 命中且判为无效', async () => {
  const short = credentials.issue('inst-ttl', { deviceId: 'dev-ttl' }, 'tok-ttl', 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(credentials.find(short.credential, 'inst-ttl'), null, '过期后 find 必须为 null');
  const record = credentials.lookup(short.credential, 'inst-ttl');
  assert.ok(record, '过期后 lookup 仍应命中');
  assert.equal(credentials.isLive(record), false, '过期凭据不得判为有效');
});

test('ttl<=0 表示不过期', async () => {
  const forever = credentials.issue('inst-forever', { deviceId: 'dev-forever' }, 'tok-forever', 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(credentials.find(forever.credential, 'inst-forever'), 'ttl<=0 的凭据不应过期');
  assert.equal(forever.expiresAt, null, '不设过期时 expiresAt 应为 null');
});
