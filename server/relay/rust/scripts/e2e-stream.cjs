'use strict';

/**
 * 端到端验证（第二组）：SSE 流式、手机 WebSocket 桥接、隧道被取代时的清理。
 *
 * 与 e2e.cjs 分开是因为它们的失败模式不同：e2e 验的是「一次请求进得去出得来」，
 * 这里验的是「长连接与流式」——那是最容易「看着连上了其实一条字节都没走」的部分。
 *
 *   node server/relay/rust/scripts/e2e-stream.cjs <rust-relay-binary>
 */

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const { RelayTunnel } = require(path.join(ROOT, 'test', 'fake-desktop.js'));
const { WebSocketServer, WebSocket } = require(path.join(ROOT, '..', '..', '..', 'dsh-mobile-plugin', 'node_modules', 'ws'));

const RELAY_PORT = 18800;
/** 夹具宿主的实例 id：公用中转按它分发请求，宿主与请求头都要带。 */
const INSTANCE = 'e2e-stream-a';
const UPSTREAM_PORT = 18801;

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/sse')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // 分三次推，中间留间隔——一次推完和「流式」在字节上分不出来。
        res.write('data: one\n\n');
        setTimeout(() => res.write('data: two\n\n'), 80);
        setTimeout(() => {
          res.write('data: three\n\n');
          res.end();
        }, 160);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    // 上游 WS：收到什么就回什么，前面加个前缀。
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.send(Buffer.concat([Buffer.from('bin:'), data]));
        } else {
          socket.send(`echo:${data}`);
        }
      });
    });
    server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 发一个 SSE 请求，返回收集到的事件数组与耗时。 */
function collectSse(urlPath) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const events = [];
    const req = http.get(`http://127.0.0.1:${RELAY_PORT}${urlPath}`, { headers: { accept: 'text/event-stream', 'x-dsh-instance': INSTANCE } }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push({ data: line.slice(6), at: Date.now() - started });
        }
      });
      res.on('end', () => resolve({ events, elapsed: Date.now() - started, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => reject(new Error('SSE 请求超时')));
  });
}

/** 通过中转打开一条手机 WS，返回它和收到的消息队列。 */
function openPhoneWs(urlPath) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}${urlPath}`, { headers: { 'x-dsh-instance': INSTANCE } });
    const messages = [];
    const waiters = [];
    socket.on('message', (data, isBinary) => {
      const item = { data: isBinary ? Buffer.from(data) : data.toString(), isBinary };
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else messages.push(item);
    });
    socket.on('open', () => resolve({ socket, messages, next: () => new Promise((r) => { const m = messages.shift(); if (m) return r(m); waiters.push(r); }) }));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('手机 WS 连不上')), 10_000);
  });
}

/** 按端口等中转起来（心跳那段跑在另一个端口上）。 */
function waitForRelayPort(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error(`端口 ${port} 上的中转没起来`));
      const probe = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(attempt, 100);
      });
      probe.on('error', () => setTimeout(attempt, 100));
    };
    attempt();
  });
}

function waitForRelay(proc) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    let timer = null;
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error('中转没有在 10 秒内起来'));
      const probe = http.get(`http://127.0.0.1:${RELAY_PORT}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        timer = setTimeout(attempt, 100);
      });
      probe.on('error', () => {
        timer = setTimeout(attempt, 100);
      });
    };
    if (proc.exitCode !== null) return reject(new Error(`中转进程已退出 code=${proc.exitCode}`));
    attempt();
  });
}

async function main() {
  const binary = process.argv[2];
  if (!binary) {
    console.error('用法：node e2e-stream.cjs <rust-relay-binary>');
    process.exit(2);
  }

  const upstream = await startUpstream();
  const relay = spawn(binary, [], {
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (d) => process.stdout.write(`[relay] ${d}`));
  relay.stderr.on('data', (d) => process.stderr.write(`[relay:err] ${d}`));

  const failures = [];
  const check = (name, ok, detail) => {
    if (ok) console.log(`✔ ${name}`);
    else {
      console.log(`✖ ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
    }
  };

  let tunnel = null;
  try {
    await waitForRelay(relay);
    tunnel = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await tunnel.connect();
    await new Promise((r) => setTimeout(r, 200));

    // ── SSE 流式 ──────────────────────────────────────────────────
    const sse = await collectSse('/sse');
    check('SSE 三条事件都到了', sse.events.length === 3, `收到 ${sse.events.length} 条`);
    check('SSE 内容正确且有序', sse.events.map((e) => e.data).join(',') === 'one,two,three', sse.events.map((e) => e.data).join(','));
    // 流式的判据：第一条与最后一条之间有时间差，说明是边推边到而不是攒完一次发。
    const spread = sse.events.length >= 2 ? sse.events[sse.events.length - 1].at - sse.events[0].at : 0;
    check('SSE 是边推边到，不是攒完一次发', spread >= 100, `首尾间隔 ${spread}ms`);
    check('SSE 的 content-type 原样带回', /text\/event-stream/.test(sse.headers['content-type'] || ''), sse.headers['content-type']);

    // ── 手机 WebSocket 桥接 ───────────────────────────────────────
    const phone = await openPhoneWs('/ws-echo');
    await new Promise((r) => setTimeout(r, 150));
    phone.socket.send('hello');
    const echo = await Promise.race([phone.next(), new Promise((_, rej) => setTimeout(() => rej(new Error('WS 回显超时')), 5000))]);
    check('手机 WS 文本往返', echo.data === 'echo:hello', echo.data);

    phone.socket.send(Buffer.from([1, 2, 3]));
    const binEcho = await Promise.race([phone.next(), new Promise((_, rej) => setTimeout(() => rej(new Error('WS 二进制回显超时')), 5000))]);
    const binOk = binEcho.isBinary && Buffer.from(binEcho.data).equals(Buffer.concat([Buffer.from('bin:'), Buffer.from([1, 2, 3])]));
    check('手机 WS 二进制往返', binOk, JSON.stringify(binEcho));
    phone.socket.close();

    // ── 隧道被取代 ────────────────────────────────────────────────
    const second = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await second.connect();
    await new Promise((r) => setTimeout(r, 300));

    // 新隧道接过之后，转发应当仍然正常（旧连接已被顶掉）。
    const afterReplace = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${RELAY_PORT}/after-replace`, { headers: { 'x-dsh-instance': INSTANCE } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('取代后转发超时')));
    });
    check('隧道被取代后转发仍然通', afterReplace.status === 200 && afterReplace.body === 'ok', JSON.stringify(afterReplace));

    second.close();

    // ── 在途请求在隧道被顶掉时要快速失败 ──────────────────────────
    // 另起一个上游，那个路由永远不响应，让请求停在途中。
    const slowUpstream = http.createServer(() => { /* 永不结束 */ });
    await new Promise((r) => slowUpstream.listen(UPSTREAM_PORT + 5, '127.0.0.1', r));
    const slowTunnel = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT + 5}`,
      onLog: () => {},
    });
    await slowTunnel.connect();
    await new Promise((r) => setTimeout(r, 200));

    const startedAt = Date.now();
    const inflight = new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${RELAY_PORT}/never-answers`, { headers: { 'x-dsh-instance': INSTANCE } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - startedAt }));
      });
      req.on('error', (error) => resolve({ error: error.message, ms: Date.now() - startedAt }));
    });
    await new Promise((r) => setTimeout(r, 300));

    // 顶掉它。
    const takeover = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await takeover.connect();

    const inflightResult = await Promise.race([
      inflight,
      new Promise((r) => setTimeout(() => r({ timeout: true, ms: Date.now() - startedAt }), 5000)),
    ]);
    check(
      '在途请求在隧道被顶掉后快速失败',
      !inflightResult.timeout && inflightResult.ms < 2000,
      JSON.stringify(inflightResult),
    );
    check(
      '在途请求拿到 502 与原因，而不是干等超时',
      inflightResult.status === 502 && /unavailable|replaced/i.test(inflightResult.body || ''),
      JSON.stringify(inflightResult),
    );
    takeover.close();
    slowTunnel.close();
    slowUpstream.close();

    // ── 心跳超时：连着但不回 pong 的隧道必须被踢掉 ────────────────
    // 这一段另起一个中转进程，把超时调得很短，否则要等 60 秒。
    const hbRelay = spawn(binary, [], {
      env: { ...process.env, PORT: String(RELAY_PORT + 100), HOST: '127.0.0.1', TUNNEL_HEARTBEAT_MS: '200', TUNNEL_PONG_TIMEOUT_MS: '700' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    hbRelay.stdout.on('data', () => {});
    hbRelay.stderr.on('data', () => {});
    try {
      await waitForRelayPort(RELAY_PORT + 100);
      const halfOpen = new WebSocket(`ws://127.0.0.1:${RELAY_PORT + 100}/tunnel`, { headers: { 'x-dsh-instance': INSTANCE } });
      let closed = false;
      halfOpen.on('close', () => { closed = true; });
      halfOpen.on('error', () => {});
      halfOpen.on('message', () => {}); // 收到 ping 也不回 pong
      await new Promise((r) => setTimeout(r, 1600));
      check('不回 pong 的隧道被判定死链并断开', closed, `closed=${closed}`);
      const afterKill = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${RELAY_PORT + 100}/status`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        }).on('error', () => resolve('err'));
      });
      check('死链之后 /status 说 hostConnected=false', JSON.parse(afterKill).hostConnected === false, afterKill);
    } finally {
      hbRelay.kill('SIGTERM');
    }
  } finally {
    try { tunnel && tunnel.close(); } catch { /* ignore */ }
    relay.kill('SIGTERM');
    upstream.close();
  }

  // ── 控制台与准入 ─────────────────────────────────────────────
  // 这一段用一次性的临时库，单独起一个开了 PLATFORM_ENABLED 的中转，与上面那条
  // 纯转发的中转互不干扰。**必须放在 finally 之外**：finally 里不能收尾退出，
  // 否则这一段永远跑不到（上一版就栽在这里，输出停在「开放模式」那条之后）。
  await runConsoleChecks(binary, check);

  if (failures.length > 0) {
    console.error(`\n${failures.length} 条失败：${failures.join('、')}`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

/**
 * 控制台开关与隧道准入。
 *
 * 重点验的是**绕过**：限制模式必须在握手阶段就拒掉，不能只在 `register` 帧里判——
 * 后者只有真实插件会走，任何人拿个最简 ws 客户端直连 `/tunnel` 就能绕过去。
 */
async function runConsoleChecks(binary, check) {
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const path = require('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-console-'));
  const consolePort = RELAY_PORT + 50;
  const env = {
    ...process.env,
    PORT: String(consolePort),
    HOST: '127.0.0.1',
    PLATFORM_ENABLED: '1',
    PLATFORM_DB_PATH: path.join(dir, 'c.db'),
    PLATFORM_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    PLATFORM_OIDC_CLIENT_SECRET: 'test',
  };
  let child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const waitUp = () => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error('控制台中转没起来'));
      const probe = http.get(`http://127.0.0.1:${consolePort}/api/platform/v1/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(attempt, 100);
      });
      probe.on('error', () => setTimeout(attempt, 100));
    };
    attempt();
  });

  const request = (method, urlPath, headers = {}) => new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: consolePort, path: urlPath, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });

  const wsProbe = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${consolePort}/tunnel`, { headers });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      resolve('timeout');
    }, 3000);
    // 连上之后必须**等它真的关掉**再往下走：中转只有一条隧道槽位，占着不放会让后续
    // 探测卡在「连上但等不到响应」上。
    ws.on('open', () => {
      clearTimeout(timer);
      ws.on('close', () => resolve('open'));
      try { ws.close(); } catch { resolve('open'); }
      // 关不掉也别把整组测试吊死。
      setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } resolve('open'); }, 800);
    });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(`http-${res.statusCode}`); });
    ws.on('error', () => { clearTimeout(timer); resolve('error'); });
  });

  try {
    await waitUp();
    const health = await request('GET', '/api/platform/v1/health');
    check('控制台健康接口在开启时可用', health.status === 200 && health.body.includes('dsh-relay'), health.body);
    const me = await request('GET', '/api/platform/v1/me');
    check('未登录访问控制台接口回 401', me.status === 401, `status=${me.status}`);

    // 开放模式（默认）：不带码也能建隧道，升级上来不会突然连不上。
    check('开放模式下不带码也能建隧道', (await wsProbe({})) === 'open');

    // 切到限制模式，重启让新进程读到设置。
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(env.PLATFORM_DB_PATH);
    db.exec("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('admission_mode', 'restricted', '2026-01-01T00:00:00.000Z')");
    db.exec("INSERT OR REPLACE INTO licenses (id, owner_id, code, device_limit, status, note, created_at, updated_at) VALUES ('L1', NULL, 'DSH-TEST-CODE-AAAA-BBB2', 1, 'active', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    db.close();

    child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    await waitUp();

    check('限制模式下不带码的隧道在握手阶段被拒', (await wsProbe({})) === 'http-401');
    check('限制模式下错码的隧道在握手阶段被拒',
      (await wsProbe({ 'x-dsh-license': 'DSH-NOPE-NOPE-NOPE-NOPE' })) === 'http-401');
    check('限制模式下正确码能建隧道（且大小写不敏感）',
      (await wsProbe({ 'x-dsh-license': 'dsh-test-code-aaaa-bbb2' })) === 'open');

    // 控制台页面：部署了产物就要能吐出来，没部署就回一句人话而不是 404。
    const page = await request('GET', '/platform/');
    const hasBundle = page.status === 200 && page.body.includes('<div id="root">');
    const saysMissing = page.status === 503 && page.body.includes('控制台前端还没部署');
    check('控制台页面：有产物就吐页面，没产物说明去哪放', hasBundle || saysMissing,
      `status=${page.status} body=${page.body.slice(0, 80)}`);
    if (hasBundle) {
      // 页面引用的资源必须真的取得到，否则打开是一片白。
      const asset = /\/platform\/assets\/[^"']+\.js/.exec(page.body);
      if (asset) {
        const js = await request('GET', asset[0]);
        check('控制台引用的 js 资源取得到', js.status === 200, `status=${js.status} ${asset[0]}`);
      }
    }
    // 路径穿越不能得手。
    const traversal = await request('GET', '/platform/assets/../../etc/passwd');
    check('控制台静态资源挡住路径穿越', traversal.status !== 200, `status=${traversal.status}`);

    // ── 主控端 / 被控端 ──────────────────────────────────────
    // 主控端的库这里直接写一条认领码：管理接口要登录，而登录要微信，e2e 里造不出来。
    // 验的是**协议行为**（认领码能不能收上报），不是微信登录本身。
    const post = (urlPath, headers, payload) => new Promise((resolve) => {
      const data = JSON.stringify(payload ?? {});
      const req = http.request(
        {
          host: '127.0.0.1',
          port: consolePort,
          path: urlPath,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(data);
      req.end();
    });

    const masterDb = new DatabaseSync(env.PLATFORM_DB_PATH);
    masterDb.exec(
      "INSERT OR REPLACE INTO nodes (id, claim_code, name, created_at, updated_at) VALUES ('n1', 'NODE-ABCD-EFGH', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    masterDb.close();

    const reported = await post(
      '/api/platform/v1/nodes/report',
      { 'x-dsh-claim': 'node-abcd-efgh' },
      { name: '被控端甲', publicUrl: 'https://relay.example.com', admissionMode: 'restricted', licenseCount: 3, deviceCount: 2, tunnelOnline: true },
    );
    check('主控端接受被控端上报（认领码大小写不敏感）', reported.status === 200, reported.body);

    const afterReport = new DatabaseSync(env.PLATFORM_DB_PATH);
    const row = afterReport.prepare("SELECT name, admission_mode, license_count FROM nodes WHERE id = 'n1'").get();
    afterReport.close();
    check('上报之后主控端能看到被控端的名字与状态',
      row && row.name === '被控端甲' && row.admission_mode === 'restricted' && row.license_count === 3,
      JSON.stringify(row));

    const unknownClaim = await post('/api/platform/v1/nodes/report', { 'x-dsh-claim': 'NODE-NOPE-NOPE' }, {});
    check('未知认领码的上报被拒', unknownClaim.status === 404, `status=${unknownClaim.status}`);

    // ── 主控端下发准入模式 ────────────────────────────────────
    // 管理接口要登录，e2e 里造不出微信会话，所以期望值直接写库；验的是**回包**这一环：
    // 被控端就是靠每次上报的响应把模式取回去的。
    check('主控端没表态时，上报回包不带 admissionMode',
      !reported.body.includes('admissionMode') && JSON.parse(reported.body).ok === true,
      reported.body);

    const setMode = new DatabaseSync(env.PLATFORM_DB_PATH);
    setMode.exec("UPDATE nodes SET desired_mode = 'restricted' WHERE id = 'n1'");
    setMode.close();

    const withMode = await post('/api/platform/v1/nodes/report', { 'x-dsh-claim': 'NODE-ABCD-EFGH' }, {});
    check('主控端设了模式之后，下一次上报就把它带回给被控端',
      JSON.parse(withMode.body).admissionMode === 'restricted', withMode.body);

    const backToAuto = new DatabaseSync(env.PLATFORM_DB_PATH);
    backToAuto.exec("UPDATE nodes SET desired_mode = '' WHERE id = 'n1'");
    backToAuto.close();
    const auto = await post('/api/platform/v1/nodes/report', { 'x-dsh-claim': 'NODE-ABCD-EFGH' }, {});
    check('交还给被控端自己决定之后，回包又不带模式',
      !auto.body.includes('admissionMode'), auto.body);

    // ── 公开接口限流 ─────────────────────────────────────────
    // 激活码校验匿名可调，不限次数就等于送了一个免费查询服务。
    // e2e 的服务端默认额度是 30，这里连打 35 次，必须开始回 429。
    const verifyStatuses = [];
    for (let i = 0; i < 35; i += 1) {
      const r = await post(
        '/api/platform/v1/licenses/verify',
        { 'x-real-ip': '203.0.113.9' },
        { code: 'DSH-NOPE-NOPE-NOPE-NOPE' },
      );
      verifyStatuses.push(r.status);
    }
    check('激活码校验超过额度之后回 429',
      verifyStatuses.includes(429), `状态序列尾部=${verifyStatuses.slice(-5).join(',')}`);
    check('额度之内是正常回答，不是一上来就挡',
      verifyStatuses.slice(0, 3).every((s) => s === 200), verifyStatuses.slice(0, 3).join(','));

    // ── 插件 OTA 临时通道 ────────────────────────────────────
    // 验的是宿主那条救急链路要的那几样：latest 的响应形状、带 token 才发布、
    // 下载回来的字节与上传的一字不差。包内容不做校验（客户端自己会验结构）。
    const otaPublished = await new Promise((resolve) => {
      const payload = Buffer.from('fake-tarball-bytes');
      const req = http.request(
        {
          host: '127.0.0.1',
          port: consolePort,
          path: '/api/desktop-plugins/ota/publish?platform=darwin&channel=stable&version=1.2.3',
          method: 'POST',
          headers: { 'content-type': 'application/gzip', 'content-length': payload.length },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(payload);
      req.end();
    });
    // 没配控制面 token 时发布接口是关的（403），配了才开（401 说明 token 不匹配）。
    check('OTA 发布接口未授权时被挡', otaPublished.status === 401 || otaPublished.status === 403,
      `status=${otaPublished.status}`);

    const otaLatest = await request('GET', '/api/desktop-plugins/ota/latest?platform=darwin&channel=stable');
    check('OTA latest 在没发过包时如实回 ok:false',
      otaLatest.status === 200 && otaLatest.body.includes('"ok":false'),
      otaLatest.body);

    // ── 主控端 token ─────────────────────────────────────────
    // 认领码是写在面板上给人抄的，不是秘密。主控端配了 PLATFORM_MASTER_TOKEN 之后，
    // 只有认领码一个人不够——被控端把主控地址填成别人的中转时，不会把状态送出去。
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    child = spawn(binary, [], {
      env: { ...env, PLATFORM_MASTER_TOKEN: 'e2e-master-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    await waitUp();

    const noToken = await post('/api/platform/v1/nodes/report', { 'x-dsh-claim': 'NODE-ABCD-EFGH' }, {});
    check('配了主控 token 之后，只带认领码的上报被拒', noToken.status === 401, `status=${noToken.status}`);

    const wrongToken = await post(
      '/api/platform/v1/nodes/report',
      { 'x-dsh-claim': 'NODE-ABCD-EFGH', authorization: 'Bearer nope' },
      {},
    );
    check('主控 token 不对的上报被拒', wrongToken.status === 401, `status=${wrongToken.status}`);

    const goodToken = await post(
      '/api/platform/v1/nodes/report',
      { 'x-dsh-claim': 'NODE-ABCD-EFGH', authorization: 'Bearer e2e-master-token' },
      { name: '被控端乙', licenseCount: 1 },
    );
    check('带对主控 token 的上报被接受', goodToken.status === 200, goodToken.body);

    // 移除之后：403（不是 404）——被控端据此知道该去要个新认领码，而不是去核对地址。
    const revokeDb = new DatabaseSync(env.PLATFORM_DB_PATH);
    revokeDb.exec("UPDATE nodes SET revoked_at = '2026-10-17T00:00:00.000Z' WHERE id = 'n1'");
    revokeDb.close();
    // 这一段跑在「主控 token」那台的进程上，所以要把 token 一起带上；
    // 这里验的是移除之后的分支，不是鉴权。
    const revoked = await post(
      '/api/platform/v1/nodes/report',
      { 'x-dsh-claim': 'NODE-ABCD-EFGH', authorization: 'Bearer e2e-master-token' },
      {},
    );
    check('被移除之后上报回 403，与「码不认识」的 404 分得开',
      revoked.status === 403, `status=${revoked.status} ${revoked.body}`);

    const stillThere = new DatabaseSync(env.PLATFORM_DB_PATH);
    const kept = stillThere.prepare("SELECT revoked_at FROM nodes WHERE id = 'n1'").get();
    stillThere.close();
    check('移除不删记录：主控端仍然看得见这台曾经存在', kept && kept.revoked_at,
      JSON.stringify(kept));
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
