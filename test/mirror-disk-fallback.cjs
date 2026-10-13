'use strict';

/**
 * 端到端回归：磁盘兜底镜像必须真的装进内存，并在后续请求里继续生效。
 *
 * 背景（见 lib/pair.js requestView 注释与 test/instance-view-state.cjs）：
 * server.js 曾把 `mobileInstance(req) || pairedInstance(req)` 返回的**浅拷贝视图**
 * 直接交给 proxyCached()，而 installMirror() 对 inst.mirror / mirrorAt /
 * mirrorSlotAt 都是重赋值 —— 写在视图上等于丢弃。后果：中转刚重启（内存冷）、
 * 或桌面还没推第一份快照时，磁盘上明明有快照，手机却拿不到，被回源成 401/502；
 * 且 mirrorDiskMissAt 负缓存永不生效，每个请求都同步读盘 + JSON.parse（上限 4MB）。
 *
 * 这个用例把真实的 relay server.js 跑起来（不 mock 代理层），预先在
 * MIRROR_DATA_DIR 放一份**新鲜**镜像（mirrorAt = now，因此不会触发后台刷新，
 * 用例是确定性的），注册一个「内存里没有镜像」的桌面隧道，然后用真实设备凭据：
 *   1. 请求 /sessions → 必须返回磁盘镜像内容（修好前会落到 live 代理拿到 live-item）；
 *   2. 断言 instances 里那个本体真的拿到了 mirror / mirrorAt / mirrorSlotAt；
 *   3. **删掉磁盘文件**再请求另一个槽位 → 仍然从内存镜像应答（修好前必然回源）。
 * 另外验证磁盘上没有镜像时 mirrorDiskMissAt 负缓存落在本体上。
 *
 * 运行：node test/mirror-disk-fallback.cjs
 */

process.env.PORT = String(process.env.MIRROR_FALLBACK_PORT || 18706);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'mirror-fallback-secret-0123456789';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mirror-fallback-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');
// MIRROR_DATA_DIR 在 tunnel-handler.js 模块加载时读取，必须先设好。
const MIRROR_DIR = path.join(tmp, 'mirror-data');
process.env.MIRROR_DATA_DIR = MIRROR_DIR;

require('ws');
const { server } = require('../server.js');
const { instances } = require('../lib/registry.js');
const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const { RelayTunnel } = require('../../dsh-mobile-plugin/lib/relay/tunnel.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const INSTANCE = 'mirrordisk01';
const COLD_INSTANCE = 'mirrordisk02';
const MIRROR_FILE = path.join(MIRROR_DIR, `mirror-${INSTANCE}.json`);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

/** 假桌面上游：任何请求都回 live-item，用来区分「读镜像」与「回源」。 */
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ live: true, ok: true, items: [{ id: 'live-item' }], path: req.url }));
});

function authed(p, credential) {
  return fetch(RELAY_HTTP + p, {
    headers: {
      'x-dsh-instance': INSTANCE,
      authorization: 'Bearer mirror-token',
      'x-dsh-device-credential': credential,
    },
  });
}

async function main() {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  // mirrorAt = now：镜像新鲜，proxyCached 不会发起后台刷新，用例确定性。
  fs.writeFileSync(
    MIRROR_FILE,
    JSON.stringify({
      mirror: {
        sessions: { ok: true, items: [{ id: 'disk-item' }] },
        workspaces: { ok: true, items: [] },
      },
      mirrorAt: Date.now(),
    }),
    'utf8',
  );

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}, upstream on ${upBase}, mirror dir ${MIRROR_DIR}\n`);

  const t = new RelayTunnel({
    relayUrl: `ws://127.0.0.1:${PORT}/tunnel`,
    instanceId: INSTANCE,
    pairingCode: '424242',
    name: 'mirror-fallback',
    upstream: upBase,
    onPairRequest: (msg) => t.sendPairConfirm(msg.requestId, true, 'mirror-token'),
  });
  await t.start();

  let credential = '';
  await test('配对成功并拿到设备凭据', async () => {
    const r = await fetch(`${RELAY_HTTP}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: INSTANCE, code: '424242', device: { name: 'Phone-Mirror' } }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    credential = j.deviceCredential;
    assert.ok(credential && credential.startsWith('dshc_'));
  });

  await test('内存无镜像时首个请求命中磁盘兜底镜像而非回源', async () => {
    const inst = instances.get(INSTANCE);
    assert.ok(inst, '实例应已注册');
    assert.strictEqual(inst.mirror, undefined, '前提：内存里还没有镜像');
    const r = await authed('/api/mobile/v1/sessions', credential);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.deepStrictEqual(j.items, [{ id: 'disk-item' }], '应返回磁盘镜像内容');
    assert.strictEqual(j.live, undefined, '不应回源到桌面');
    assert.strictEqual(j.stale, false, '镜像是新鲜的');
  });

  await test('磁盘镜像已装进实例本体（instances 里的那个对象）', async () => {
    const inst = instances.get(INSTANCE);
    assert.ok(inst.mirror && inst.mirror.sessions, '镜像必须落在本体上，不是请求视图上');
    assert.strictEqual(inst.mirror.sessions.items[0].id, 'disk-item');
    assert.ok(Number(inst.mirrorAt) > 0, 'mirrorAt 也要落在本体上');
    assert.ok(inst.mirrorSlotAt && Number(inst.mirrorSlotAt.sessions) > 0, '槽位时间戳要落在本体上');
  });

  await test('删掉磁盘文件后仍从内存镜像应答（旧实现必然回源）', async () => {
    fs.rmSync(MIRROR_FILE);
    const inst = instances.get(INSTANCE);
    assert.ok(inst.mirror, '前提：内存里已有镜像');
    const r = await authed('/api/mobile/v1/workspaces', credential);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.deepStrictEqual(j.items, [], '应返回内存镜像里的空 workspaces');
    assert.strictEqual(j.live, undefined, '磁盘文件已删，回源说明内存镜像没装进本体');
  });

  await test('磁盘上没有镜像时 mirrorDiskMissAt 负缓存落在本体', async () => {
    // 造一个已注册但内存/磁盘都没有镜像的实例，只需凭据可用。
    instances.set(COLD_INSTANCE, { instanceId: COLD_INSTANCE, pending: new Map(), tunnel: null });
    const issued = credentials.issue(COLD_INSTANCE, { deviceId: 'cold-dev' }, 'cold-token');
    assert.strictEqual(instances.get(COLD_INSTANCE).mirrorDiskMissAt, undefined);
    await fetch(`${RELAY_HTTP}/api/mobile/v1/sessions`, {
      headers: {
        'x-dsh-instance': COLD_INSTANCE,
        authorization: 'Bearer cold-token',
        'x-dsh-device-credential': issued.credential,
      },
    }).catch(() => {});
    const after = instances.get(COLD_INSTANCE).mirrorDiskMissAt;
    assert.ok(
      Number(after) > 0,
      '负缓存没落在本体上 → 每个请求都会同步读盘 + JSON.parse（上限 4MB）',
    );
  });

  t.stop();
  server.close();
  upstream.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
