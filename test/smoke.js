'use strict';

/**
 * dsh-mobile-server 端到端冒烟测试：
 *  进程内启动中转服务器 + 假上游（模拟 dsh web）+ 参考隧道（RelayTunnel），
 *  用 fetch / ws 客户端模拟手机端全流程。
 *
 * 运行：npm test（或 node test/smoke.js）
 */

process.env.PORT = String(process.env.SMOKE_PORT || 18700);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'smoke-secret-0123456789';

const http = require('node:http');
const assert = require('node:assert');
const { WebSocketServer, WebSocket } = require('ws');
const { server } = require('../server.js');
const { RelayTunnel } = require('./fake-desktop.js');
const { T } = require('../lib/protocol.js');

const PORT = Number(process.env.PORT);
const RELAY_HTTP = `http://127.0.0.1:${PORT}`;
const RELAY_WS = `ws://127.0.0.1:${PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假上游（模拟 dsh web：根页面 / JSON API / SSE / WS 回环）──────────
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>FAKE-UPSTREAM-ROOT</body></html>');
  } else if (url.pathname === '/api/echo') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: JSON.parse(b || '{}') }));
    });
  } else if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => {
      res.write('data: two\n\n');
      res.end();
    }, 40);
  } else {
    res.writeHead(404);
    res.end('nf');
  }
});
const upWss = new WebSocketServer({ server: upstream, path: '/ws' });
upWss.on('connection', (ws) => ws.on('message', (d) => ws.send(d)));

// ── 测试工具 ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}
let cookie = '';
let mobileToken = '';
let deviceCredential = '';
async function req(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (opts.json) headers['content-type'] = 'application/json';
  return fetch(RELAY_HTTP + path, { method: opts.method || 'GET', headers, body: opts.body });
}

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  const upstream2 = http.createServer((req, res) => {
    if (req.url === '/api/mobile/v1/route-probe') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('SECOND-DESKTOP');
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  await new Promise((r) => upstream2.listen(0, '127.0.0.1', r));
  const upBase2 = `http://127.0.0.1:${upstream2.address().port}`;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`relay on ${RELAY_HTTP}, upstream on ${upBase}\n`);

  const t1 = new RelayTunnel({
    relayUrl: RELAY_WS,
    instanceId: 'smoke01',
    pairingCode: '123456',
    name: 'Mac mini',
    lanUrls: ['http://192.168.1.20:8700'],
    lanCandidates: [{ url: 'http://192.168.1.20:8700', interface: 'en0', family: 'IPv4' }],
    upstream: upBase,
  });
  await t1.start();
  const t2 = new RelayTunnel({
    relayUrl: RELAY_WS,
    instanceId: 'smoke02',
    pairingCode: '654321',
    name: 'Android tablet',
    upstream: upBase2,
  });
  await t2.start();

  await test('healthz', async () => {
    const res = await req('/healthz');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'ok');
  });

  await test('根路径是 JSON 404，不返回 HTML', async () => {
    const res = await req('/');
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /^application\/json/i);
    assert.doesNotMatch(await res.text(), /<html/i);
  });

  await test('配对 API 的浏览器 GET 返回 JSON 405', async () => {
    for (const path of ['/pair', '/r/smoke01/pair']) {
      const res = await req(path);
      assert.strictEqual(res.status, 405, path);
      assert.match(res.headers.get('content-type') || '', /^application\/json/i, path);
      assert.doesNotMatch(await res.text(), /<html/i, path);
    }
  });

  await test('/r/<id> 是 JSON 404，不返回 HTML', async () => {
    const res = await req('/r/smoke01');
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /^application\/json/i);
    assert.doesNotMatch(await res.text(), /<html/i);
  });

  await test('离线实例配对 → 404', async () => {
    const res = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'ghost99', code: '123456' }),
    });
    assert.strictEqual(res.status, 404);
  });

  await test('错误配对码 → 401', async () => {
    const res = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke01', code: '000000' }),
    });
    assert.strictEqual(res.status, 401);
  });

  await test('正确配对 → 200 + 下发 dsh_pair cookie + token', async () => {
    const res = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke01', code: '123456', device: { name: 'Phone-1' } }),
    });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(typeof j.token, 'string', '配对响应应包含桌面端签发的 token');
    assert.ok(j.token.length > 0);
    mobileToken = j.token;
    deviceCredential = j.deviceCredential;
    assert.ok(deviceCredential);
    const sc = res.headers.get('set-cookie') || '';
    const m = sc.match(/dsh_pair=([^;]+)/);
    assert.ok(m, '响应缺少 set-cookie');
    cookie = `dsh_pair=${m[1]}`;
  });

  await test('connection-info requires both mobile credentials and returns LAN metadata', async () => {
    const headers = { 'X-Dsh-Instance': 'smoke01', 'X-Dsh-Device-Credential': deviceCredential, Authorization: `Bearer ${mobileToken}` };
    const res = await fetch(`${RELAY_HTTP}/api/mobile/v1/connection-info`, { headers });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.instanceId, 'smoke01');
    assert.deepStrictEqual(j.lanUrls, ['http://192.168.1.20:8700']);
    assert.deepStrictEqual(j.lanCandidates[0].interface, 'en0');
    assert.ok(Number.isFinite(j.lastSeen));
    assert.ok(Number.isFinite(j.updatedAt));
  });

  await test('connection-info rejects instance id without valid credentials', async () => {
    const res = await fetch(`${RELAY_HTTP}/api/mobile/v1/connection-info`, { headers: { 'X-Dsh-Instance': 'smoke01' } });
    assert.strictEqual(res.status, 401);
  });

  await test('移动 API 实例头优先于冲突的全局 cookie', async () => {
    const res = await fetch(`${RELAY_HTTP}/api/mobile/v1/route-probe`, {
      headers: { Cookie: cookie, 'X-Dsh-Instance': 'smoke02', Authorization: 'Bearer test-token' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'SECOND-DESKTOP');
  });

  await test('移动 status 禁止无 Authorization 的实例探测', async () => {
    const res = await fetch(`${RELAY_HTTP}/api/mobile/v1/status`, {
      headers: { 'X-Dsh-Instance': 'smoke02' },
    });
    assert.strictEqual(res.status, 401);
  });

  await test('配对被桌面端拒绝 → 403', async () => {
    const tRej = new RelayTunnel({
      relayUrl: RELAY_WS,
      instanceId: 'smoke04',
      pairingCode: '444444',
      upstream: upBase,
      autoApprovePair: false,
      onPairRequest: (msg) => {
        tRej.sendJson(T.pairConfirm, 0, { requestId: msg.requestId, approved: false });
      },
    });
    await tRej.start();
    const res = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke04', code: '444444' }),
    });
    assert.strictEqual(res.status, 403, '拒绝后手机应收到 403');
    const j = await res.json();
    assert.strictEqual(j.ok, false);
    tRej.stop();
  });

  await test('带 cookie 访问根路径仍为 JSON 404', async () => {
    const res = await req('/');
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /^application\/json/i);
    assert.doesNotMatch(await res.text(), /<html/i);
  });

  await test('移动 API 路径：无 cookie 但带 X-Dsh-Instance → 代理到桌面', async () => {
    const ok = await fetch(`${RELAY_HTTP}/api/mobile/v1/status`, {
      headers: { 'X-Dsh-Instance': 'smoke01', Authorization: 'Bearer test-token' },
    });
    // 请求到达上游（上游对未知路径返回 404 'nf'），而非 relay 配对落地页
    assert.strictEqual(ok.status, 404);
    assert.strictEqual(await ok.text(), 'nf');
    // status 不允许无 Authorization 的匿名探测
    const no = await fetch(`${RELAY_HTTP}/api/mobile/v1/status`);
    assert.strictEqual(no.status, 401);
    const ghost = await fetch(`${RELAY_HTTP}/api/mobile/v1/status`, {
      headers: { 'X-Dsh-Instance': 'ghost99', Authorization: 'Bearer test-token' },
    });
    assert.strictEqual(ghost.status, 401, '未知实例不得返回状态或落地页');
  });

  await test('配对 cookie 不能调用 Desktop 控制面', async () => {
    const res = await req('/api/relay/status');
    assert.strictEqual(res.status, 403);
    assert.match(await res.text(), /local-only/);
  });

  await test('带 cookie 代理 POST /api/echo', async () => {
    const res = await req('/api/echo', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { echo: { hello: 'world' } });
  });

  await test('大请求体流式透传（httpBody 分块）', async () => {
    const payload = JSON.stringify({ big: 'x'.repeat(512 * 1024) });
    const res = await req('/api/echo', {
      method: 'POST',
      json: true,
      body: payload,
    });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.echo.big.length, 512 * 1024, '大请求体应完整透传');
  });

  await test('SSE 流式透传（httpChunk 分块）', async () => {
    const res = await req('/api/events');
    assert.strictEqual(res.status, 200);
    let text = '';
    for await (const chunk of res.body) text += Buffer.from(chunk).toString('utf8');
    assert.ok(text.includes('data: one'), `缺少第一个 SSE 块，实际收到: ${JSON.stringify(text.slice(0, 200))}`);
    assert.ok(text.includes('data: two'), '缺少第二个 SSE 块');
  });

  await test('WS 桥接回环（手机 WS ↔ 上游 WS）', async () => {
    const ws = new WebSocket(`${RELAY_WS}/ws`, { headers: { 'X-Dsh-Instance': 'smoke01', 'X-Dsh-Device-Credential': deviceCredential, Authorization: `Bearer ${mobileToken}` } });
    const got = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws echo 超时')), 5000);
      ws.on('open', () => ws.send('ping-from-phone'));
      ws.on('message', (d) => {
        clearTimeout(t);
        resolve(d.toString());
      });
      ws.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    ws.close();
    assert.strictEqual(got, 'ping-from-phone');
  });

  await test('phone WS rejects pairing cookie or instance id without valid credentials', async () => {
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`${RELAY_WS}/ws`, { headers: { Cookie: cookie, 'X-Dsh-Instance': 'smoke01', Authorization: `Bearer ${mobileToken}` } });
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      ws.on('unexpected-response', () => finish('rejected'));
      ws.on('error', () => finish('rejected'));
      ws.on('open', () => finish('connected'));
      setTimeout(() => finish('timeout'), 4000);
    });
    assert.strictEqual(result, 'rejected');
  });

  await test('未配对 WS 升级被拒', async () => {
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`${RELAY_WS}/ws`);
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      ws.on('unexpected-response', () => finish('rejected'));
      ws.on('error', () => finish('rejected'));
      ws.on('open', () => finish('connected'));
      setTimeout(() => finish('timeout'), 4000);
    });
    assert.strictEqual(result, 'rejected');
  });

  await test('配对限流：5 次失败后锁定（正确码也 429）', async () => {
    const t2 = new RelayTunnel({
      relayUrl: RELAY_WS,
      instanceId: 'smoke02',
      pairingCode: '654321',
      upstream: upBase,
    });
    await t2.start();
    for (let i = 0; i < 5; i++) {
      const r = await req('/pair', {
        method: 'POST',
        json: true,
        body: JSON.stringify({ instanceId: 'smoke02', code: '000000' }),
      });
      assert.ok([401, 429].includes(r.status), `第 ${i + 1} 次应为 401/429，实际 ${r.status}`);
    }
    const r6 = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke02', code: '654321' }),
    });
    assert.strictEqual(r6.status, 429, '锁定期内正确配对码也应被拒');
    t2.stop();
  });

  await test('注册认证：错误配对码顶替现有实例被拒（1008）', async () => {
    const hijack = new RelayTunnel({
      relayUrl: RELAY_WS,
      instanceId: 'smoke01',
      pairingCode: '000000', // 与已注册的 123456 不一致
      upstream: upBase,
    });
    const err = await new Promise((resolve) => {
      hijack.start().then(() => resolve(null)).catch((e) => resolve(e));
    });
    assert.ok(err, '顶替应被拒绝');
    assert.match(String(err && err.message), /bad pairing code|隧道关闭/i);
    hijack.stop();
    // 原实例不受影响：仍可用原配对码配对
    const res = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke01', code: '123456' }),
    });
    assert.strictEqual(res.status, 200, '原实例配对码应保持有效');
  });

  await test('注册认证：正确配对码可顶替（合法重连）', async () => {
    const t3 = new RelayTunnel({
      relayUrl: RELAY_WS,
      instanceId: 'smoke01',
      pairingCode: '123456',
      name: 'Mac mini (relogin)',
      upstream: upBase,
    });
    await t3.start(); // 应成功顶替
    const res = await req('/r/smoke01');
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /^application\/json/i);
    assert.doesNotMatch(await res.text(), /<html/i);
    t3.stop();
    await delay(300);
    // 恢复 t1 作为后续测试的实例
    await t1.start();
  });

  await test('updatePairing：新码立即生效、旧码失效', async () => {
    const t4 = new RelayTunnel({
      relayUrl: RELAY_WS,
      instanceId: 'smoke03',
      pairingCode: '111111',
      upstream: upBase,
    });
    await t4.start();
    t4.updatePairingCode('222222'); // 经隧道同步新码
    await delay(200);
    const rOld = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke03', code: '111111' }),
    });
    assert.strictEqual(rOld.status, 401, '旧配对码应已失效');
    const rNew = await req('/pair', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ instanceId: 'smoke03', code: '222222' }),
    });
    assert.strictEqual(rNew.status, 200, '新配对码应可配对');
    t4.stop();
  });

  await test('网页路径与退出流程均为 JSON 404', async () => {
    t1.stop();
    t2.stop();
    await delay(400);
    for (const path of ['/', '/r/smoke01', '/__logout__', '/some-page']) {
      const res = await req(path);
      assert.strictEqual(res.status, 404, path);
      assert.match(res.headers.get('content-type') || '', /^application\/json/i, path);
      assert.doesNotMatch(await res.text(), /<html/i, path);
    }
  });

  // ── 清理与汇总 ──
  upstream.close();
  upstream2.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('失败项：');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
