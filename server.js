'use strict';

/**
 * DSH 自建版中转：一个纯转发进程。
 *
 * 它自己不生成任何内容，也不决定「谁能用」：宿主（跑在用户电脑上的
 * [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)）主动向本进程建立一条
 * 出站 WSS 隧道，手机上来的 HTTP / SSE / WebSocket 原样送进那条隧道，宿主的响应原样
 * 送回手机。所以本进程无需入站可达用户电脑的网络。
 *
 * 三条边界，别越：
 *   - **一条隧道**。同一时刻只服务一条宿主连接，新连接直接取代旧的（见 lib/tunnel.js）。
 *     自建版是「一个人给自己一台电脑搭的」，不做多租户；要一台中转挂多台机器是运营版
 *     与中控端那条线的事。
 *   - **不鉴权**。存取控制是宿主的事，中转只转发；配对、设备凭据、注册准入都不在这里。
 *   - **不解释业务**。不缓存、不存镜像、不认路径语义，请求头逐跳头之外一律原样带过去。
 *
 * 自己认领的路径只有 `/healthz` 与 `/api/mobile/v1/health`（地址体检），其余全部转发。
 *
 * 隧道帧格式见 ./PROTOCOL.md；`lib/protocol.js` 是与插件侧逐字节对齐的唯一事实源，
 * 由 dsh-mobile-plugin/test/protocol-parity.test.cjs 钉住 —— 本文件只使用其中的
 * http* / ws* / ping / pong 这些转发帧。
 */

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const { T, encodeFrame, createFrameDecoder } = require('./lib/protocol.js');
const { MAX_FRAME_BYTES, TUNNEL_HEARTBEAT_MS, TUNNEL_PONG_TIMEOUT_MS } = require('./lib/config.js');
const { log, createTunnel, getTunnel, setTunnel, clearTunnel } = require('./lib/tunnel.js');
const { proxyRequest, sendText, sendJson } = require('./lib/proxy-http.js');
const { handlePhoneWs } = require('./lib/bridge-ws.js');
const { handleTunnelFrame, failAllPending } = require('./lib/tunnel-handler.js');

// ── 配置 ────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8700);
/** 版本号只有一个来源（包自己的 package.json）：地址体检接口如实自报。 */
const RELAY_VERSION = require('./package.json').version;

// 入口脚本挂上来的额外模块（运营版的平台、中控）。中转自己不认识它们，
// 只在请求入口按顺序问一句「这个请求你接不接」，见下面的挂载点。
const mountedModules = [];

// ── HTTP ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://relay.local');
  try {
    if (url.pathname === '/healthz') return sendText(res, 200, 'ok');

    // 地址体检：手机在**配对/接入之前**问「这个地址上是谁」，因此刻意不鉴权。回答只有
    // 服务名与版本，消费方 app/src/services/viewmodels/addressProbe.ts。
    if (url.pathname === '/api/mobile/v1/health') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, service: 'dsh-mobile-relay', version: RELAY_VERSION });
    }

    // 额外模块（运营版的平台 / 中控）：`handle()` 同步返回 true 表示它已接管并自行应答，
    // false 表示继续走中转逻辑。中转自己的路由一条都没让出去，不挂模块时这里就是空循环。
    for (const extra of mountedModules) {
      if (extra.handle(req, res, url)) return;
    }

    const tunnel = getTunnel();
    if (!tunnel) return sendJson(res, 503, { ok: false, error: 'no host tunnel connected' });
    return proxyRequest(tunnel, req, res);
  } catch (err) {
    log('request error:', err.message);
    try {
      sendText(res, 500, 'internal error');
    } catch { /* ignore */ }
  }
});

// ── WebSocket（隧道 + 手机桥接）────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 9, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://relay.local').pathname;
  if (pathname === '/tunnel') {
    // 握手回调不是同步完成的，所以名额之类的前置判断不能放在 wss.on('tunnel') 里。
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('tunnel', ws, req);
    });
    return;
  }
  // `/tunnel` 之外的所有升级请求都是「手机 ↔ 宿主」的 WS 桥接。
  const tunnel = getTunnel();
  if (!tunnel) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('phone', ws, req, tunnel);
  });
});

wss.on('tunnel', (ws, tunnelReq) => {
  const tunnel = createTunnel(ws);
  const previous = setTunnel(tunnel);
  if (previous && previous.ws !== ws) {
    // 新连接直接赢：旧连接上没结束的请求一次性失败，否则它们会挂在旧隧道对象上等到
    // 客户端自己的超时（旧连接还可能停在 OPEN，连 close 帧都收不到）。
    log('replacing existing tunnel');
    failAllPending(previous, 'replaced');
    try { previous.ws.close(1001, 'replaced'); } catch { /* ignore */ }
  }
  log(`tunnel connected remote=${tunnelReq?.socket?.remoteAddress || ''}`);

  let lastPong = Date.now();
  const push = createFrameDecoder((frame) => {
    // 代次守卫：被取代的旧连接仍可能推帧，它的帧不能落进新隧道的 pending 里。
    if (getTunnel() !== tunnel) return;
    tunnel.lastSeen = Date.now();
    if (frame.type === T.pong) {
      lastPong = Date.now();
      return;
    }
    if (frame.type === T.ping) {
      try { ws.send(encodeFrame(T.pong, 0, Buffer.alloc(0))); } catch { /* ignore */ }
      return;
    }
    handleTunnelFrame(tunnel, frame);
  }, {
    maxFrameBytes: MAX_FRAME_BYTES,
    onError: () => { try { ws.close(1009, 'frame too large'); } catch { /* ignore */ } },
  });

  ws.on('message', (data, isBinary) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));

  // 隧道心跳：定期发应用层 ping；宿主回 pong（协议 v2），长时间未收到视为死链。
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > TUNNEL_PONG_TIMEOUT_MS) {
      log('tunnel heartbeat timeout, terminating');
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    try { ws.send(encodeFrame(T.ping, 0, Buffer.alloc(0))); } catch { /* ignore */ }
  }, TUNNEL_HEARTBEAT_MS);

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    if (clearTunnel(tunnel)) {
      failAllPending(tunnel, `tunnel closed ${code} ${reason || ''}`);
      log(`tunnel closed code=${code} reason=${String(reason || '').slice(0, 160)}`);
    } else {
      log(`superseded tunnel closed code=${code}`);
    }
  });
  ws.on('error', (err) => { log(`tunnel ws error: ${err && err.message ? err.message : String(err)}`); });
});

wss.on('phone', (ws, req, tunnel) => {
  handlePhoneWs(ws, req, tunnel);
});

// ── 生命周期 ────────────────────────────────────────────────────────
function start(options = {}) {
  const host = options.host || HOST;
  const port = options.port == null ? PORT : Number(options.port);

  // 额外模块由入口脚本创建后传进来（运营版见 dsh-mobile-hub/server.js）。中转不预判有谁、
  // 也不在模块级 require 它们——那会让每个 import server.js 的测试都替它们开一次资源。
  if (Array.isArray(options.modules)) mountedModules.push(...options.modules);

  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      log(`dsh-mobile-server listening on http://${host}:${address?.port || port}`);
      resolve({ host, port: address?.port || port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function stop() {
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }
  const tunnel = getTunnel();
  if (tunnel) {
    try { failAllPending(tunnel, 'relay shutting down'); } catch { /* ignore */ }
    clearTunnel(tunnel);
  }
  const closingModules = mountedModules.splice(0, mountedModules.length);
  return new Promise((resolve) => {
    const finish = () => {
      if (!closingModules.length) return resolve();
      Promise.all(
        closingModules.map((extra) => {
          try {
            return Promise.resolve(extra.close?.());
          } catch (error) {
            log('module close failed:', error.message);
            return Promise.resolve();
          }
        }),
      ).then(resolve, (error) => { log('module close failed:', error.message); resolve(); });
    };
    if (!server.listening) return finish();
    server.close(finish);
    // keep-alive 的空闲连接不会自己走，只调 close() 会让关停一直等下去（Node 19 起全局
    // agent 默认 keepAlive，这个等待是常态而不是意外）。在途请求已经在上面失败过了。
    server.closeAllConnections?.();
  });
}

if (require.main === module) {
  start().catch((error) => { log('startup failed:', error.message); process.exitCode = 1; });
  const shutdown = () => { stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { server, start, stop };
