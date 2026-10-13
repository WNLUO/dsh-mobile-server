'use strict';

/**
 * 顶替竞态守卫测试：旧隧道被顶替之后，它还在途的帧不得再被处理。
 *
 * 背景：隧道注册处每条连接都有一个闭包变量 `inst`。新隧道顶替旧隧道时，旧连接的 `inst`
 * 仍指向**旧实例对象**，而旧对象的 `inst.tunnel` 正是那条旧 ws —— 所以帧入口的
 * `if (!inst || inst.tunnel !== ws) return;` 拦不住它，close 路径早就有的
 * `instances.get(inst.instanceId) === inst` 却只有 close 路径在用。
 *
 * 最重的后果是 T.sync：它会把旧宿主推来的镜像 `saveMirrorToDisk(inst.instanceId, …)`，
 * 而磁盘文件名只按 instanceId 取 —— 上一代宿主的数据能覆盖新实例稍后要读的磁盘兜底镜像。
 *
 * 复现手法：让 A 注册后 `ws._socket.pause()`，A 就永远收不到中转发来的 close 帧（它自己仍
 * 是 OPEN，仍能发帧），于是「旧隧道在顶替后继续发帧」可以确定性复现；随后 B 用同一
 * instanceId + 同一 pairingCode 顶替。断言：A 的帧被丢弃（有日志）、手机读到的仍是 B 的
 * 镜像、磁盘上不出现 A 的内容，而 B 自己的推送照常生效（守卫只拦旧代次，不拦正常路径）。
 *
 * 运行：node test/superseded-tunnel.cjs
 */

process.env.PORT = String(process.env.SUPERSEDED_PORT || 18721);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'superseded-race-secret-0123456789';
process.env.RELAY_CACHE_TTL_MS = '60000'; // 镜像保持新鲜，避免后台刷新带来不确定性

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-superseded-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');
// MIRROR_DATA_DIR 在 tunnel-handler.js 模块加载时读取，必须先设好。
const MIRROR_DIR = path.join(tmp, 'mirror-data');
process.env.MIRROR_DATA_DIR = MIRROR_DIR;

require('ws');
const { server } = require('../server.js');
const { instances } = require('../lib/registry.js');
const { T } = require('../lib/protocol.js');
const { RelayTunnel } = require('./fake-desktop.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const INSTANCE = 'race01';
const PAIRING_CODE = '424242';
const MIRROR_FILE = path.join(MIRROR_DIR, `mirror-${INSTANCE}.json`);
const HOST_TOKEN = `test-token-${INSTANCE}`; // fake-desktop 自动批准配对时用的 token

// 中转的 log() 走 console.log；抓下来断言「丢弃」确实发生过（也证明帧真的到达了中转）。
const logLines = [];
const realLog = console.log;
console.log = (...args) => { logLines.push(args.map(String).join(' ')); };
const note = (...args) => realLog(...args);
const sawLog = (needle) => logLines.some((l) => l.includes(needle));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await delay(25);
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    note(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    note(`  ✗ ${name} — ${err.message}`);
  }
}

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ live: true, ok: true, items: [{ id: 'live-item' }] }));
});

const mirrorOf = (itemId) => ({
  sessions: { ok: true, items: [{ id: itemId }] },
  workspaces: { ok: true, items: [] },
});

async function main() {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  note(`relay on ${RELAY_HTTP}, upstream on ${upBase}\n`);

  const mk = (name) => new RelayTunnel({
    relayUrl: `ws://127.0.0.1:${PORT}`,
    instanceId: INSTANCE,
    pairingCode: PAIRING_CODE,
    name,
    upstream: upBase,
  });

  const a = mk('tunnel-A');
  await a.start();
  // 关键：暂停 A 的读方向 —— 中转发给 A 的 close 帧 A 永远读不到，A 自己仍是 OPEN、仍能发帧。
  a.ws._socket.pause();

  const b = mk('tunnel-B');
  await b.start();

  let credential = '';
  await test('B 用同一配对码顶替成功，实例表指向 B', async () => {
    assert.ok(sawLog(`tunnel replacing ${INSTANCE}`), '中转应当记录顶替');
    const inst = instances.get(INSTANCE);
    assert.ok(inst, '实例仍在表里');
    // 注意：instances 里存的是**服务端侧**的 ws 对象，与测试进程里的 b.ws 不是同一个引用，
    // 用注册时上报的 name 判断代次。
    assert.strictEqual(inst.name, 'tunnel-B', '实例表必须指向新隧道 B');
  });

  await test('配对拿到设备凭据（由 B 批准）', async () => {
    const r = await fetch(`${RELAY_HTTP}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: INSTANCE, code: PAIRING_CODE, device: { name: 'Phone-Race' } }),
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    credential = j.deviceCredential;
    assert.ok(credential && credential.startsWith('dshc_'));
  });

  await test('B 的镜像推送正常生效（守卫不误伤正常路径）', async () => {
    b.sendJson(T.sync, 0, mirrorOf('GOOD-FROM-B'));
    const inst = await waitFor('B 的镜像落地', () => {
      const cur = instances.get(INSTANCE);
      return cur && cur.mirror && cur.mirror.sessions && cur.mirror.sessions.items[0].id === 'GOOD-FROM-B' ? cur : null;
    });
    assert.strictEqual(inst.name, 'tunnel-B');
  });

  await test('A（已被顶替）的 T.sync 被丢弃并记日志', async () => {
    const generation = instances.get(INSTANCE);
    a.sendJson(T.sync, 0, mirrorOf('STALE-FROM-A'));
    await waitFor('代次守卫日志', () => sawLog('tunnel frame from superseded connection dropped'));
    assert.ok(
      sawLog(`tunnel frame from superseded connection dropped: instance=${INSTANCE} type=sync`),
      '日志应带实例与帧类型',
    );
    assert.strictEqual(instances.get(INSTANCE), generation, '顶替后实例对象不得再被换掉');
    // 再给 A 一点时间：如果守卫缺失，镜像此刻已经被覆盖。
    await delay(150);
    const inst = instances.get(INSTANCE);
    assert.strictEqual(
      inst.mirror.sessions.items[0].id,
      'GOOD-FROM-B',
      '旧隧道的帧不得写进内存镜像',
    );
  });

  await test('手机读到的仍是 B 的镜像，且磁盘兜底没被旧代次污染', async () => {
    const r = await fetch(`${RELAY_HTTP}/api/mobile/v1/sessions`, {
      headers: {
        'x-dsh-instance': INSTANCE,
        authorization: `Bearer ${HOST_TOKEN}`,
        'x-dsh-device-credential': credential,
      },
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.items[0].id, 'GOOD-FROM-B', '手机不得看到旧宿主的镜像');
    assert.strictEqual(j.live, undefined, '不应回源');

    const disk = await waitFor('磁盘镜像落盘', () => {
      try {
        const raw = fs.readFileSync(MIRROR_FILE, 'utf8');
        return raw.includes('GOOD-FROM-B') ? raw : null;
      } catch { return null; }
    });
    assert.ok(!disk.includes('STALE-FROM-A'), '磁盘镜像（按 instanceId 命名）不得被旧代次覆盖');
  });

  a.ws.terminate();
  b.stop();
  server.close();
  upstream.close();
  console.log = realLog;
  note(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log = realLog;
  console.error(err);
  process.exit(1);
});
