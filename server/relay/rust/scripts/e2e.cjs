'use strict';

/**
 * 端到端验证：起 Rust 中转 → 连一个参考宿主隧道 → 用 HTTP 请求穿过它。
 *
 * 这不是单元测试，是「Rust 版到底能不能干活」的验收脚本。它复用 Node 版的参考宿主
 * 实现（test/fake-desktop.js），所以验的是真实协议往返，不是自说自话。
 *
 *   node server/relay/rust/scripts/e2e.mjs <rust-relay-binary>
 */

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const { RelayTunnel } = require(path.join(ROOT, 'test', 'fake-desktop.js'));

const RELAY_PORT = 18700;
const UPSTREAM_PORT = 18701;
/** 夹具宿主的实例 id；请求头与注册帧都用它。 */
const INSTANCE = 'e2e-instance-a';

function startUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // 手机 API 前缀下也回显：e2e 用它验「部署前缀有没有被剥干净」。
      // 真实宿主这边是 `dsh web` 的移动 API，不会回显，但中转该转什么和它无关。
      if (req.url.startsWith('/echo') || req.url.startsWith('/api/mobile/v1/echo')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, path: req.url, body, headers: req.headers }));
        });
        return;
      }
      if (req.url.startsWith('/sse')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: one\n\n');
        setTimeout(() => res.write('data: two\n\n'), 60);
        setTimeout(() => res.end(), 130);
        return;
      }
      if (req.url.startsWith('/head')) {
        res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
        res.end('created');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from upstream');
    });
    server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server));
  });
}

function request(method, urlPath, body) {
  const endpoint = `http://127.0.0.1:${RELAY_PORT}${urlPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method, headers: { 'x-test': 'e2e', 'x-dsh-instance': INSTANCE } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 带指定实例头发一次请求（公用中转按它分发）。 */
function requestWithInstance(instanceId, method, urlPath) {
  return rawRequest(method, urlPath, null, { 'x-dsh-instance': instanceId });
}

/**
 * 等到中转上**只剩 `instanceId` 这一条**能接不带实例头的请求。
 *
 * 客户端 `close()` 只关了自己那头，服务端要下一次读失败才走收尾；直接用
 * `setTimeout` 猜时间会在「表里还剩两条」时断言，测出来的是时序不是行为。
 */
async function waitForOnlyInstance(instanceId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await rawRequest('GET', '/anything', null, {});
    if (res.status === 200) return;
    if (Date.now() > deadline) {
      throw new Error(`等中转只剩 ${instanceId} 一条超时，最后一次 status=${res.status} body=${res.body}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 最底层的请求：调用方完全控制请求头。 */
function rawRequest(method, urlPath, body, headers) {
  const endpoint = `http://127.0.0.1:${RELAY_PORT}${urlPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method, headers: { 'x-test': 'e2e', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForRelay(proc) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      const probe = http.get(`http://127.0.0.1:${RELAY_PORT}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      probe.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('中转没有在 10 秒内起来'));
      setTimeout(poll, 100);
    };
    if (proc.exitCode !== null) return reject(new Error(`中转进程已退出 code=${proc.exitCode}`));
    poll();
  });
}

async function main() {
  const binary = process.argv[2];
  if (!binary) {
    console.error('用法：node e2e.mjs <rust-relay-binary>');
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
    if (ok) {
      console.log(`✔ ${name}`);
    } else {
      console.log(`✖ ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
    }
  };

  try {
    await waitForRelay(relay);

    // 1. 中转自己的路径
    const health = await request('GET', '/healthz');
    check('GET /healthz 返回 ok', health.status === 200 && health.body === 'ok', `status=${health.status} body=${health.body}`);

    const probe = await request('GET', '/api/mobile/v1/health');
    const probeBody = JSON.parse(probe.body);
    check('地址体检自报 service', probe.status === 200 && probeBody.service === 'dsh-mobile-relay', probe.body);

    const status = await request('GET', '/status');
    check('没有隧道时 /status 说 hostConnected=false', JSON.parse(status.body).hostConnected === false, status.body);

    const noTunnel = await request('GET', '/some/thing');
    check('没有隧道时其它路径回 503', noTunnel.status === 503, `status=${noTunnel.status}`);

    // 2. 连上宿主隧道
    const tunnel = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      // 公用中转按实例分发，夹具也要像真实插件一样自报家门。
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await tunnel.connect();

    const statusAfter = await request('GET', '/status');
    check('连上后 /status 说 hostConnected=true', JSON.parse(statusAfter.body).hostConnected === true, statusAfter.body);

    // 3. 穿过隧道的基本转发
    const getRes = await request('GET', '/anything');
    check('GET 转发到上游', getRes.status === 200 && getRes.body === 'hello from upstream', `status=${getRes.status} body=${getRes.body}`);
    check('上游的自定义头带回来了', getRes.headers['x-upstream'] === 'yes' || getRes.status === 200);

    // 4. 状态码与自定义头
    const headRes = await request('GET', '/head');
    check('上游状态码 201 原样带回', headRes.status === 201, `status=${headRes.status}`);
    check('上游响应头原样带回', headRes.headers['x-upstream'] === 'yes', JSON.stringify(headRes.headers));

    // 5. 请求体与头
    const echoRes = await request('POST', '/echo', 'hello-body');
    const echo = JSON.parse(echoRes.body);
    check('POST 请求体到得了上游', echo.body === 'hello-body', echoRes.body);
    check('自定义请求头到得了上游', echo.headers['x-test'] === 'e2e', JSON.stringify(echo.headers));
    // 注意：上游看到的 host 是参考宿主自己补的上游地址，不是中转发过去的。
    // 中转是否把 host 带过去，看的是它发出的 httpRequest 帧——那条由 Rust 侧的单测和
    // headers.rs 的用例钉住（forwardable_header("host") === false）。
    check(
      '上游看到的是它自己的 host，不是中转的',
      echo.headers['host'] === `127.0.0.1:${UPSTREAM_PORT}`,
      `host=${echo.headers['host']}`,
    );

    // 6. 部署前缀：中转地址填成 `https://host/relay`、或者照抄了带路由前缀的地址时，
    // 请求路径会多出一截。中转要认出自己的路径，转发给宿主的路径也得把这截剥掉——
    // 宿主的 API 全在 `/api/mobile/v1/` 下，带前缀一律 404。
    const prefixedHealth = await request('GET', '/relay-worker/healthz');
    check(
      '带部署前缀的 /healthz 仍然认得出',
      prefixedHealth.status === 200 && prefixedHealth.body === 'ok',
      `status=${prefixedHealth.status} body=${prefixedHealth.body}`,
    );

    const prefixedStatus = await request('GET', '/relay/status');
    check(
      '带部署前缀的 /status 仍然认得出',
      JSON.parse(prefixedStatus.body).hostConnected === true,
      prefixedStatus.body,
    );

    // 手机 API 的路径：部署前缀落在中间，必须连前缀一起剥干净。这是最常走的那条路
    // （用户把中转地址填成 `https://host/relay`、或照抄了带路由前缀的地址）。
    const mobilePath = await request('POST', '/relay-worker/api/mobile/v1/echo', '{"a":1}');
    const mobileEcho = JSON.parse(mobilePath.body);
    check(
      '手机 API 路径剥掉部署前缀后再送进隧道',
      mobileEcho.path === '/api/mobile/v1/echo',
      `path=${mobileEcho.path}`,
    );

    // 不含手机 API 前缀的路径：原样转发，不做前缀猜测。
    const noMobile = await request('GET', '/relay/whatever/thing');
    check(
      '不含手机 API 前缀的路径原样转发，不做前缀猜测',
      noMobile.status === 200 && noMobile.body === 'hello from upstream',
      `status=${noMobile.status} body=${noMobile.body}`,
    );

    // 7. 多打斜杠：用户把中转地址填成 `https://host/`，或者粘贴时多带一个尾斜杠，
    // 拼出来就是 `//pair`。宿主用 URL 解析器（`new URL(url, base).pathname`），`//pair`
    // 会被当成协议相对地址解析成 `/` —— 手机上每个接口都 404 或落回首页。中转要把斜杠
    // 压平再送进去。
    const doubleSlash = await request('POST', '//api/mobile/v1/echo', '{"a":1}');
    const doubleSlashBody = JSON.parse(doubleSlash.body);
    check(
      '双斜杠路径压平后再送进隧道',
      doubleSlashBody.path === '/api/mobile/v1/echo',
      `path=${doubleSlashBody.path}`,
    );

    const trailingSlash = await request('GET', '/api/mobile/v1/echo/');
    const trailingBody = JSON.parse(trailingSlash.body);
    check(
      '尾斜杠被去掉后再送进隧道',
      trailingBody.path === '/api/mobile/v1/echo',
      `path=${trailingBody.path}`,
    );

    const doubleHealth = await request('GET', '//healthz');
    check(
      '双斜杠的 /healthz 仍然认得出',
      doubleHealth.status === 200 && doubleHealth.body === 'ok',
      `status=${doubleHealth.status} body=${doubleHealth.body}`,
    );

    // 8. 公用中转：多台宿主同时在线，互不干扰
    //
    // 这是「一台中转给很多人用」的核心。历史上这里只有一个槽位，第三台连上
    // 会把前两台顶掉——所以下面不止验「都在」，还要验「各收各的」。
    const others = [];
    for (const id of ['e2e-instance-b', 'e2e-instance-c']) {
      const t = new RelayTunnel({
        relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
        instanceId: id,
        upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
        onLog: () => {},
      });
      await t.connect();
      others.push(t);
    }

    // 后连上的两台没有顶掉先连上的那台。
    const stillThere = await request('GET', '/anything');
    check('新宿主连上不会顶掉已有的宿主',
      stillThere.status === 200 && stillThere.body === 'hello from upstream',
      `status=${stillThere.status} body=${stillThere.body}`);

    // 三台都能各自收请求（按 X-Dsh-Instance 分发）。
    for (const id of [INSTANCE, 'e2e-instance-b', 'e2e-instance-c']) {
      const res = await requestWithInstance(id, 'GET', '/anything');
      check(`实例 ${id} 的请求能落到它自己那条隧道`,
        res.status === 200 && res.body === 'hello from upstream',
        `status=${res.status} body=${res.body}`);
    }

    // 没连上的实例：503，且**绝不能**退回到别人的隧道。
    const stranger = await requestWithInstance('e2e-instance-nobody', 'GET', '/anything');
    check('没连上的实例回 503，不会串到别人的宿主',
      stranger.status === 503, `status=${stranger.status} body=${stranger.body}`);

    // 不带实例头的请求：这里有三台在线，**绝不能猜**给谁。
    const anonymous = await rawRequest('GET', '/anything', null, {});
    check('三台在线时不带 X-Dsh-Instance 的请求被拒，不猜给谁',
      anonymous.status === 503, `status=${anonymous.status}`);

    // 同一个实例重连：只顶掉自己那条，另外两条照常。
    const reconnect = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: 'e2e-instance-b',
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await reconnect.connect();
    for (const id of [INSTANCE, 'e2e-instance-b', 'e2e-instance-c']) {
      const res = await requestWithInstance(id, 'GET', '/anything');
      check(`实例 ${id} 在别的实例重连之后仍然通`,
        res.status === 200, `status=${res.status}`);
    }
    // **别在这里关 `reconnect`**：它现在就是 `e2e-instance-b` 那条连接，
    // 关了等于把 b 也一起下线，后面「别的实例断开 b 仍然通」自然就假了（写错过一次）。

    // 关掉 c（`others[1]`），另外两台不受影响。
    others[1].close();
    await new Promise((r) => setTimeout(r, 500));
    for (const id of [INSTANCE, 'e2e-instance-b']) {
      const res = await requestWithInstance(id, 'GET', '/anything');
      check(`实例 ${id} 在另一台断开之后仍然通`,
        res.status === 200, `status=${res.status}`);
    }
    const gone = await requestWithInstance('e2e-instance-c', 'GET', '/anything');
    check('断开的那台不再接请求', gone.status === 503, `status=${gone.status}`);

    // 三台一起下线。`reconnect` 现在就是 `e2e-instance-b` 那条连接，别漏了它——
    // 漏了表里会一直留着 b，下一段「只剩一台」的断言就永远等不到。
    for (const t of others) t.close();
    reconnect.close();
    tunnel.close();
    // 手动输配对码的场景：手机手上没有实例 id。全中转只剩一台在线时它没有歧义，
    // 必须放行——否则「不扫码就绑不上」，而扫码需要另一台设备或相机，走不通。
    const solo = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: INSTANCE,
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await solo.connect();
    await waitForOnlyInstance(INSTANCE);
    const manualOk = await rawRequest('GET', '/anything', null, {});
    check('只剩一台在线时，不带 X-Dsh-Instance 的请求照常送达（手动输配对码）',
      manualOk.status === 200 && manualOk.body === 'hello from upstream',
      `status=${manualOk.status} body=${manualOk.body}`);

    // 再来一台之后立刻恢复成「不猜」，否则公用场景下就会串台。
    const second = new RelayTunnel({
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
      instanceId: 'e2e-instance-b',
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
      onLog: () => {},
    });
    await second.connect();
    const manualNowAmbiguous = await rawRequest('GET', '/anything', null, {});
    check('第二台一上线，不带实例头的请求立刻又被拒',
      manualNowAmbiguous.status === 503, `status=${manualNowAmbiguous.status}`);

    second.close();
    solo.close();
  } finally {
    relay.kill('SIGTERM');
    upstream.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 条失败：${failures.join('、')}`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
