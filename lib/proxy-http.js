'use strict';

/**
 * HTTP 代理（手机 → 隧道，v2 流式）+ 小型 HTTP 响应助手 + 隧道帧发送。
 *
 * 中转不解释业务语义：请求头（逐跳头与 `host` 除外）原样带过去，响应头同理。
 *
 * 两个方向都有背压，落点不同：响应方向（宿主 → 手机）靠 `httpPause` / `httpResume`
 * 帧请宿主自己停；请求方向（手机 → 宿主）停读手机的请求流，协议上不需要新帧。
 *
 * 依赖方向：protocol + config + tunnel（log）。
 */

const { T, encodeFrame } = require('./protocol.js');
const { MAX_BODY_BYTES, MAX_PENDING, MAX_SSE_CONNECTIONS, UPSTREAM_HEADER_TIMEOUT_MS, DEBUG_SSE } = require('./config.js');
const { log } = require('./tunnel.js');

const MAX_BODY = MAX_BODY_BYTES;

// SSE 空闲哨兵阈值。宿主侧的 keepalive 是每 15s 一行注释，所以 30s 一个字节都没有
// 就说明上游既不产出也不会终止（例如 stream.js 的 mux 循环抛错被吞、收尾又被吞）。
const SSE_IDLE_TIMEOUT_MS = 30_000;

// 逐跳头：只对单条 TCP 连接有意义，转给对端会把连接语义一起带过去。
// 这份集合与 `dsh-mobile-plugin/lib/relay/lan-proxy.js` 手工同步，
// 由 `dsh-mobile-plugin/test/shared-helpers-parity.test.cjs` 逐项比对。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

// ── 小工具 ──────────────────────────────────────────────────────────
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}
function sendJson(res, status, obj) {
  sendText(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

/** 逐跳头之外一律原样转发；`host` 指向的是中转自己的域名，不能带给宿主。 */
function forwardableHeader(name) {
  const lower = String(name).toLowerCase();
  return !HOP_BY_HOP.has(lower) && lower !== 'host';
}
function pickForwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (forwardableHeader(name)) out[name] = v;
  }
  return out;
}
function sanitizeRespHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (forwardableHeader(name)) out[name] = v;
  }
  return out;
}

function pendingCapacity(tunnel, kind) {
  if (tunnel.pending.size >= MAX_PENDING) return false;
  if (kind !== 'sse') return true;
  let sse = 0;
  for (const candidate of tunnel.pending.values()) {
    if (candidate.kind === 'http' && candidate.sse) sse += 1;
  }
  return sse < MAX_SSE_CONNECTIONS;
}

// ── 隧道帧发送（携带 id 的流式帧）─────────────────────────────────────
const MAX_TUNNEL_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * 隧道发往宿主方向的积压字节数。`ws` 没有 drain 事件，水位判定只能读这个
 * （宿主侧的水位控制同形，见 dsh-mobile-plugin/lib/relay/preview.js）。
 */
function tunnelBacklog(tunnel) {
  return Number(tunnel?.ws?.bufferedAmount || 0);
}

/**
 * 不受积压门槛管的小控制帧：取消 / 暂停 / 恢复 / 关闭。
 *
 * 积压恰恰是最需要它们的时候。一帧取消送不出去，宿主会继续往一条已经堵死的管道里灌；
 * 一帧关闭送不出去，宿主本机那条上游连接永远等不到收尾，只能等它自己超时。它们一共
 * 九字节，放行不会让积压变坏。带数据的帧照旧被挡 —— 那正是背压本身。
 */
const CONTROL_FRAME_TYPES = new Set([T.httpCancel, T.httpPause, T.httpResume, T.wsClose]);

/**
 * 停读手机上行的高/低水位（都刻意落在 MAX_TUNNEL_BUFFERED_BYTES 之下）。
 *
 * 手机上行 body 与宿主下行响应共用这条隧道：body 装满时那道 16MB 硬门槛会把请求掐成
 * 502，而用户看到的是「传了一半失败」，重传一遍还是同样的结局 —— 其实只是宿主读得慢。
 * 所以到高水位就停读手机的请求流：协议上不需要任何新帧，宿主那边只是暂时收不到
 * httpBody，等回落到低水位再放行。
 */
const TUNNEL_FEED_HIGH_WATER_BYTES = MAX_TUNNEL_BUFFERED_BYTES / 2;
const TUNNEL_FEED_LOW_WATER_BYTES = MAX_TUNNEL_BUFFERED_BYTES / 4;
const FEED_RESUME_POLL_MS = 25;

/** 这条隧道上的下一个帧 id。一条隧道一个对象，不需要再防「浅拷贝把计数器拷回初值」。 */
function allocTunnelId(tunnel) {
  tunnel.nextId += 1;
  return tunnel.nextId;
}

function sendTunnelFrame(tunnel, type, id, payload) {
  const ws = tunnel?.ws;
  if (!ws || (ws.readyState !== undefined && ws.readyState !== 1)) return false;
  const control = CONTROL_FRAME_TYPES.has(type);
  // 只让本次请求失败，不断开整条隧道：一个慢手机/一个慢请求不该打断同一条隧道上
  // 其它设备与请求。
  if (!control && tunnelBacklog(tunnel) > MAX_TUNNEL_BUFFERED_BYTES) return false;
  try {
    const frame = encodeFrame(type, id, payload);
    if (!control && tunnelBacklog(tunnel) + frame.length > MAX_TUNNEL_BUFFERED_BYTES) {
      return false;
    }
    ws.send(frame);
    return true;
  } catch { /* 隧道已断开 */
    return false;
  }
}

// ── HTTP 代理（手机 → 隧道，v2 流式）────────────────────────────────
function proxyRequest(tunnel, req, res, options = {}) {
  const isSse = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
  if (!pendingCapacity(tunnel, isSse ? 'sse' : 'http')) {
    return sendText(res, 429, 'relay resource limit exceeded');
  }
  const id = allocTunnelId(tunnel);
  const entry = { kind: 'http', res, started: false, sse: isSse, cancelled: false, paused: false, headerTimer: null, idleTimer: null, feedTimer: null };
  tunnel.pending.set(id, entry);

  const clearFeedResume = () => {
    if (!entry.feedTimer) return;
    clearInterval(entry.feedTimer);
    entry.feedTimer = null;
  };
  /**
   * 停读手机上行之后，轮询到隧道回落到低水位再放行。`ws` 没有 drain 事件，只能轮询
   * `bufferedAmount`（与宿主侧 dsh-mobile-plugin/lib/relay/preview.js 的水位控制同形，
   * 轮询间隔也一致）。
   */
  const startFeedResume = () => {
    if (entry.feedTimer) return;
    entry.feedTimer = setInterval(() => {
      if (entry.cancelled || tunnel.pending.get(id) !== entry) return clearFeedResume();
      if (tunnelBacklog(tunnel) > TUNNEL_FEED_LOW_WATER_BYTES) return;
      clearFeedResume();
      try { req.resume(); } catch { /* ignore */ }
    }, FEED_RESUME_POLL_MS);
    if (typeof entry.feedTimer.unref === 'function') entry.feedTimer.unref();
  };

  // header 阶段的超时与 SSE 与否无关：它量的是「宿主收到 httpRequest 后多久回 httpHead」，
  // 而宿主侧的 SSE 处理是**先 writeHead 再产出**，头部本来就应该立刻回来。
  entry.headerTimer = setTimeout(() => {
    if (entry.cancelled || entry.started || tunnel.pending.get(id) !== entry) return;
    entry.cancelled = true;
    tunnel.pending.delete(id);
    sendTunnelFrame(tunnel, T.httpCancel, id, Buffer.alloc(0));
    try { sendText(res, 504, 'upstream response timeout'); } catch { /* ignore */ }
  }, UPSTREAM_HEADER_TIMEOUT_MS);
  res.on('drain', () => {
    if (!entry.cancelled && entry.paused && tunnel.pending.get(id) === entry) {
      entry.paused = false;
      sendTunnelFrame(tunnel, T.httpResume, id, Buffer.alloc(0));
    }
  });
  if (isSse && DEBUG_SSE) log(`sse open path=${new URL(req.url, 'http://relay.local').pathname}`);
  const cancel = () => {
    // 响应可能在 httpEnd/httpError 摘掉条目之后才 close。只有当这次请求还归中转管的时候
    // 才通知宿主；cancelled 标志顺便压掉 req/res 两条 close 路径的重复通知。
    if (entry.cancelled || tunnel.pending.get(id) !== entry) return;
    entry.cancelled = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    clearFeedResume();
    tunnel.pending.delete(id);
    sendTunnelFrame(tunnel, T.httpCancel, id, Buffer.alloc(0));
    if (isSse && DEBUG_SSE) log(`sse cancel path=${new URL(req.url, 'http://relay.local').pathname}`);
  };
  req.on('aborted', cancel);
  res.on('close', cancel);
  const failTransport = () => {
    if (entry.cancelled || tunnel.pending.get(id) !== entry) return;
    entry.cancelled = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    clearFeedResume();
    tunnel.pending.delete(id);
    try { req.destroy(); } catch { /* ignore */ }
    try {
      if (res.headersSent || res.destroyed) res.destroy();
      else sendText(res, 502, 'tunnel unavailable');
    } catch {
      try { res.destroy(); } catch { /* ignore */ }
    }
  };
  // 立即发送请求头（不等 body 攒完）；body 随后以 httpBody 帧流式转发
  const sent = sendTunnelFrame(tunnel, T.httpRequest, id, JSON.stringify({
    method: req.method,
    path: options.path || req.url,
    headers: pickForwardHeaders(req.headers),
  }));
  if (!sent) {
    failTransport();
    return;
  }
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (entry.cancelled) return;
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      entry.cancelled = true;
      clearFeedResume();
      req.destroy();
      sendTunnelFrame(tunnel, T.httpCancel, id, Buffer.alloc(0));
      tunnel.pending.delete(id);
      try {
        sendText(res, 413, 'body too large');
      } catch { /* ignore */ }
      return;
    }
    if (!sendTunnelFrame(tunnel, T.httpBody, id, c)) {
      failTransport();
      return;
    }
    // 已经收完的报文不再停读：剩下的字节本来就在本地缓冲里，停下来只会把 body 结束帧
    // 一起推迟（宿主那边表现为「请求发了却一直没结束」），而此时要转发的量已经很小。
    if (req.complete) return;
    if (tunnelBacklog(tunnel) > TUNNEL_FEED_HIGH_WATER_BYTES) {
      try { req.pause(); } catch { /* ignore */ }
      startFeedResume();
    }
  });
  req.on('end', () => {
    clearFeedResume();
    if (aborted || entry.cancelled) return;
    if (!sendTunnelFrame(tunnel, T.httpBody, id, Buffer.alloc(0))) failTransport(); // body 结束
  });
  req.on('error', () => {
    if (!entry.cancelled) failTransport();
  });
}

// ── SSE 空闲哨兵 ────────────────────────────────────────────────────
// 上游不发终止帧时条目会一直挂在 pending 里、res 永不 end，客户端要等自己的超时才断。
// 这里在 httpHead 后武装、每个 httpChunk 重置；超过阈值一个字节都没有就主动收尾并通知
// 上游取消，客户端随即重连重放，把「无限期静默挂死」降级成一次可自愈的重连。
function armSseIdle(tunnel, id, entry) {
  if (!entry || !entry.sse) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.cancelled || tunnel.pending.get(id) !== entry) return;
    entry.cancelled = true;
    entry.idleTimer = null;
    tunnel.pending.delete(id);
    log(`sse idle timeout: id=${id} (>${SSE_IDLE_TIMEOUT_MS}ms)`);
    sendTunnelFrame(tunnel, T.httpCancel, id, Buffer.alloc(0));
    try { entry.res.end(); } catch { /* ignore */ }
  }, SSE_IDLE_TIMEOUT_MS);
}

module.exports = {
  proxyRequest,
  forwardableHeader,
  pickForwardHeaders,
  sanitizeRespHeaders,
  sendText,
  sendJson,
  sendTunnelFrame,
  tunnelBacklog,
  allocTunnelId,
  armSseIdle,
  pendingCapacity,
};
