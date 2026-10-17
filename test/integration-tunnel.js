'use strict';

/**
 * 端到端：手机 → 中转 → 真隧道（test/fake-desktop.js）→ 假上游。
 *
 * 覆盖纯转发的全部面：HTTP（含请求体与自定义头）、SSE 流式、手机 WebSocket 桥接、
 * 没有隧道时的失败、以及「新连接直接取代旧隧道」。
 *
 * 运行：node test/integration-tunnel.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const { start, stop } = require('../server.js');
const { RelayTunnel } = require('./fake-desktop.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** 假上游：一个 HTTP 服务 + 一个 WS 服务。 */
function startUpstream() {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': connected\n\n');
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          res.write(`data: ${n}\n\n`);
          if (n >= 3) { clearInterval(timer); res.end(); }
        }, 30);
        return;
      }
      // 回显方法、路径、请求头与请求体，方便断言「原样带过去了」。
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.from(data)])));
    });
  });
  return { server, wss };
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('自建版中转：HTTP / SSE / WS 全链路转发', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const relay = await start({ host: '127.0.0.1', port: 0 });
  const talk = (path, options) => request(relay.port, path, options);

  t.after(async () => {
    await stop();
    upstream.wss.close();
    upstream.server.closeAllConnections?.();
    await new Promise((r) => upstream.server.close(r));
  });

  // ① 中转自己认领的两个路径
  assert.equal((await talk('/healthz')).body, 'ok');
  const probe = await talk('/api/mobile/v1/health');
  assert.equal(probe.status, 200);
  assert.equal(JSON.parse(probe.body).service, 'dsh-mobile-relay');

  // ② 还没有隧道：如实说清楚，而不是超时
  const orphan = await talk('/api/mobile/v1/sessions');
  assert.equal(orphan.status, 503);

  // ③ 建隧道
  const host = new RelayTunnel({ relayUrl: `ws://127.0.0.1:${relay.port}`, upstream: `http://127.0.0.1:${upstreamPort}`, onLog: () => {} });
  await host.connect();

  // ④ GET：路径与自定义头原样到上游
  const got = await talk('/api/mobile/v1/sessions?fresh=1', { headers: { 'x-dsh-device-credential': 'dshc_abc', 'x-custom': 'v' } });
  assert.equal(got.status, 200);
  assert.equal(got.headers['x-upstream'], 'yes', '上游的响应头要带回来');
  const seen = JSON.parse(got.body);
  assert.equal(seen.url, '/api/mobile/v1/sessions?fresh=1');
  assert.equal(seen.headers['x-dsh-device-credential'], 'dshc_abc');
  assert.equal(seen.headers['x-custom'], 'v');
  // 中转自己的 host 不能带给上游；上游看到的应当是自己那一份（由宿主侧的 HTTP 客户端填）。
  assert.equal(seen.headers.host, `127.0.0.1:${upstreamPort}`);

  // ⑤ POST 请求体
  const posted = await talk('/api/mobile/v1/session/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"你好"}' });
  assert.equal(JSON.parse(posted.body).body, '{"text":"你好"}');

  // ⑥ SSE：分块到达，不是攒完一次给
  const chunks = [];
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: '/stream', headers: { accept: 'text/event-stream' } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.on('data', (c) => chunks.push(c.toString('utf8')));
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
  const sse = chunks.join('');
  assert.match(sse, /: connected/);
  assert.match(sse, /data: 3/);
  assert.ok(chunks.length > 1, 'SSE 必须流式到达，不能攒成一个块');

  // ⑦ 手机 WebSocket 桥接
  const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`);
  await new Promise((resolve, reject) => { phone.on('open', resolve); phone.on('error', reject); });
  const echoed = await new Promise((resolve) => {
    phone.on('message', (data) => resolve(data.toString('utf8')));
    phone.send('ping');
  });
  assert.equal(echoed, 'echo:ping');
  phone.close();

  // ⑧ 新连接直接取代旧隧道；取代之后新隧道照常服务
  const second = new RelayTunnel({ relayUrl: `ws://127.0.0.1:${relay.port}`, upstream: `http://127.0.0.1:${upstreamPort}`, onLog: () => {} });
  const oldClosed = new Promise((resolve) => host.ws.on('close', resolve));
  await second.connect();
  await oldClosed;
  const afterReplace = await talk('/api/mobile/v1/workspaces');
  assert.equal(afterReplace.status, 200);
  assert.equal(JSON.parse(afterReplace.body).url, '/api/mobile/v1/workspaces');

  // 收尾：这些长连接不主动断，node:test 会一直等事件循环清空。
  phone.terminate();
  host.close();
  second.close();
  for (const client of upstream.wss.clients) client.terminate();
});
