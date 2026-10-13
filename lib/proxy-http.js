'use strict';

/**
 * HTTP 代理（手机 → 隧道，v2 流式）+ 小型 HTTP 响应助手 + 隧道帧发送。
 *
 * 依赖方向：protocol + registry。
 */

const { T, encodeFrame } = require('./protocol.js');

const { MAX_BODY_BYTES, MAX_PENDING_PER_INSTANCE, MAX_PENDING_GLOBAL, MAX_SSE_CONNECTIONS, UPSTREAM_HEADER_TIMEOUT_MS, REQUEST_HEADERS, RESPONSE_HEADERS, DEBUG_SSE } = require('./config.js');
const { log } = require('./registry.js');

const MAX_BODY = MAX_BODY_BYTES;

// SSE 空闲哨兵阈值。插件侧的 keepalive 是每 15s 一行注释，所以 30s 一个字节都没有
// 就说明上游既不产出也不会终止（例如 stream.js 的 mux 循环抛错被吞、收尾又被吞）。
const SSE_IDLE_TIMEOUT_MS = 30_000;

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
function readJson(req, cb, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1024 * 1024) {
      aborted = true;
      // 此前只 req.destroy() 不回状态码，客户端只能看到连接被重置。
      if (res && !res.headersSent) sendText(res, 413, 'request body too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      /* 非 JSON 按空处理 */
    }
    cb(body);
  });
  req.on('error', () => {});
}
function pickForwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (REQUEST_HEADERS.has(name) && !HOP_BY_HOP.has(name)) out[name] = v;
  }
  return out;
}
function sanitizeRespHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (RESPONSE_HEADERS.has(name) && !HOP_BY_HOP.has(name)) out[name] = v;
  }
  return out;
}
function pendingCapacity(inst, kind) {
  if (inst.pending.size >= MAX_PENDING_PER_INSTANCE) return false;
  let total = 0; let sse = 0;
  for (const candidate of inst.pending.values()) {
    total += 1;
    if (candidate.kind === 'http' && candidate.sse) sse += 1;
  }
  if (total >= MAX_PENDING_GLOBAL) return false;
  return kind !== 'sse' || sse < MAX_SSE_CONNECTIONS;
}

// ── 隧道帧发送（携带 id 的流式帧）─────────────────────────────────────
const MAX_TUNNEL_BUFFERED_BYTES = 16 * 1024 * 1024;

// ── 隧道帧 id 分配 ───────────────────────────────────────────────────
// id 必须在同一实例的所有在途请求之间唯一。实例对象会以**浅拷贝**的形式交给每个
// 请求：pair.js 的 pairedInstance()/mobileInstance()/authenticatedMobileInstance()
// 都返回 `{ ...inst, __deviceCredential: record }`。`pending` 这个 Map 是按引用共享
// 的，但 `nextId` 是按值拷贝的 —— 拷贝里永远是注册时的初值。旧实现直接
// `inst.nextId++`，于是每个请求都拿到同一个 id：后一个请求覆盖前一个在 pending
// 里的条目，前一个流式响应（SSE）此后再也匹配不到条目，帧被静默丢弃，客户端只
// 收到一帧 preamble（`: connected`）然后永久静默。因此计数器按 instanceId 存在
// 模块级 Map 上，与「本次请求拿到的是哪份视图」无关。
const tunnelIdCounters = new Map();

/**
 * 实例注销时丢掉它的帧 id 计数器。
 *
 * `tunnelIdCounters` 按 instanceId 存，只增不减：每个见过（含被顶替、被拒绝注册）
 * 的 instanceId 都会永久留下一条，中转长跑时是一处无界增长。id 只需要在「实例存活
 * 期内」单调，实例已经从 `instances` 里删掉、`pending` 也清空之后，重新注册的同一
 * instanceId 从 1 重新开始是安全的（旧隧道已关，其帧被代次守卫丢弃）。
 *
 * **不要**在「被新隧道顶替」的路径上调用：那里 instanceId 还活着，id 必须继续单调，
 * 否则旧隧道在途帧的 id 会和新条目的 id 撞车。
 */
function releaseTunnelIds(instanceId) {
  tunnelIdCounters.delete(String(instanceId || ''));
}

function allocTunnelId(inst) {
  const key = String((inst && inst.instanceId) || '');
  const id = (tunnelIdCounters.get(key) || 0) + 1;
  tunnelIdCounters.set(key, id);
  return id;
}

function sendTunnelFrame(inst, type, id, payload) {
  const tunnel = inst?.tunnel;
  if (!tunnel || (tunnel.readyState !== undefined && tunnel.readyState !== 1) || Number(tunnel.bufferedAmount || 0) > MAX_TUNNEL_BUFFERED_BYTES) {
    // 只让本次请求失败。此前这里 terminate() 整条隧道，
    // 一个慢手机/一个慢请求会把同实例下其它设备与请求一起打断。
    return false;
  }
  try {
    const frame = encodeFrame(type, id, payload);
    if (Number(tunnel.bufferedAmount || 0) + frame.length > MAX_TUNNEL_BUFFERED_BYTES) {
      return false;
    }
    tunnel.send(frame);
    return true;
  } catch { /* 隧道已断开 */
    return false;
  }
}

// ── HTTP 代理（手机 → 隧道，v2 流式）────────────────────────────────
function proxyRequest(inst, req, res, options = {}) {
  const isSse = String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
  if (!pendingCapacity(inst, isSse ? 'sse' : 'http')) {
    return sendText(res, 429, 'relay resource limit exceeded');
  }
  const id = allocTunnelId(inst);
  const entry = { kind: 'http', res, started: false, sse: isSse, cancelled: false, paused: false, headerTimer: null, idleTimer: null };
  inst.pending.set(id, entry);
  // header 阶段的超时与 SSE 与否无关：它量的是「桌面端收到 httpRequest 后多久回 httpHead」，
  // 而插件侧的 SSE 处理是**先 writeHead 再产出**，头部本来就应该立刻回来。此前只给非 SSE
  // 装这个定时器，于是「宿主收到帧但永不回头」的 SSE 条目会永久挂在 pending 里：res 永不
  // end、不发 httpCancel、客户端只能等自己的超时 —— armSseIdle 要等 httpHead 之后才武装，
  // 覆盖不到这一段。两条超时在 T.httpHead 处交接（那里 clearTimeout(headerTimer) + armSseIdle）。
  entry.headerTimer = setTimeout(() => {
    if (entry.cancelled || entry.started || inst.pending.get(id) !== entry) return;
    entry.cancelled = true;
    inst.pending.delete(id);
    sendTunnelFrame(inst, T.httpCancel, id, Buffer.alloc(0));
    try { sendText(res, 504, 'upstream response timeout'); } catch { /* ignore */ }
  }, UPSTREAM_HEADER_TIMEOUT_MS);
  res.on('drain', () => {
    if (!entry.cancelled && entry.paused && inst.pending.get(id) === entry) {
      entry.paused = false;
      sendTunnelFrame(inst, T.httpResume, id, Buffer.alloc(0));
    }
  });
  if (isSse && DEBUG_SSE) log(`sse open path=${new URL(req.url, 'http://relay.local').pathname}`);
  const cancel = () => {
    // A response can close after httpEnd/httpError removed the entry. Only
    // notify Desktop while this request is still owned by the relay; the
    // cancelled flag also suppresses duplicate notifications from req/res
    // close races.
    if (entry.cancelled || inst.pending.get(id) !== entry) return;
    entry.cancelled = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    inst.pending.delete(id);
    sendTunnelFrame(inst, T.httpCancel, id, Buffer.alloc(0));
    if (isSse && DEBUG_SSE) log(`sse cancel path=${new URL(req.url, 'http://relay.local').pathname}`);
  };
  req.on('aborted', cancel);
  res.on('close', cancel);
  if (isSse && DEBUG_SSE) {
    res.on('close', () => log(`sse close path=${new URL(req.url, 'http://relay.local').pathname}`));
  }
  const failTransport = () => {
    if (entry.cancelled || inst.pending.get(id) !== entry) return;
    entry.cancelled = true;
    if (entry.headerTimer) clearTimeout(entry.headerTimer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    inst.pending.delete(id);
    try { req.destroy(); } catch { /* ignore */ }
    try {
      if (res.headersSent || res.destroyed) res.destroy();
      else sendText(res, 502, 'tunnel unavailable');
    } catch {
      try { res.destroy(); } catch { /* ignore */ }
    }
  };
  // 立即发送请求头（不再等 body 攒完）；body 随后以 httpBody 帧流式转发
  const sent = sendTunnelFrame(inst, T.httpRequest, id, JSON.stringify({
    method: req.method,
    path: options.path || req.url,
    headers: { ...pickForwardHeaders(req.headers), ...(options.headers || {}) },
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
      req.destroy();
      sendTunnelFrame(inst, T.httpCancel, id, Buffer.alloc(0));
      inst.pending.delete(id);
      try {
        sendText(res, 413, 'body too large');
      } catch { /* ignore */ }
      return;
    }
    if (!sendTunnelFrame(inst, T.httpBody, id, c)) failTransport();
  });
  req.on('end', () => {
    if (aborted || entry.cancelled) return;
    if (!sendTunnelFrame(inst, T.httpBody, id, Buffer.alloc(0))) failTransport(); // body 结束
  });
  req.on('error', () => {
    if (!entry.cancelled) failTransport();
  });
}

// ── SSE 空闲哨兵 ────────────────────────────────────────────────────
// relay 侧对已 start 的 SSE 原本没有任何超时：上游不发终止帧，条目就一直挂在
// inst.pending 里、res 永不 end，客户端要等自己的超时才断（实测挂了 600s）。
// 这里在 httpHead 后武装、每个 httpChunk 重置；超过阈值一个字节都没有就主动收尾
// 并通知上游取消，客户端随即重连重放，把「无限期静默挂死」降级成一次可自愈的重连。
function armSseIdle(inst, id, entry) {
  if (!entry || !entry.sse) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.cancelled || inst.pending.get(id) !== entry) return;
    entry.cancelled = true;
    entry.idleTimer = null;
    inst.pending.delete(id);
    log(`sse idle timeout: ${inst.instanceId} id=${id} (>${SSE_IDLE_TIMEOUT_MS}ms)`);
    sendTunnelFrame(inst, T.httpCancel, id, Buffer.alloc(0));
    try { entry.res.end(); } catch { /* ignore */ }
  }, SSE_IDLE_TIMEOUT_MS);
}

module.exports = {
  proxyRequest,
  readJson,
  pickForwardHeaders,
  sanitizeRespHeaders,
  sendText,
  sendJson,
  sendTunnelFrame,
  allocTunnelId,
  releaseTunnelIds,
  armSseIdle,
  pendingCapacity,
};
