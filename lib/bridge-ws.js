'use strict';

/**
 * WebSocket 桥接（手机 WS → 隧道 → 上游 WS）。
 *
 * 依赖方向：protocol + registry + proxy-http（sendTunnelFrame）。
 *
 * 手机 WS 的保活与隧道心跳同形：15s ping，超过 60s 既没 pong 也没收到任何上行帧就认定
 * 半开并 terminate 掉**这一条**手机 WS（不碰隧道）。只有 ping 没有 pong 判定时，半开连接
 * 会一直停在 OPEN，永久占着 pending 名额与 MAX_WS_CONNECTIONS。
 */

const { WebSocket } = require('ws');
const { T, encodeClosePayload } = require('./protocol.js');
const { log } = require('./registry.js');
const { sendTunnelFrame, pickForwardHeaders, pendingCapacity, allocTunnelId } = require('./proxy-http.js');
const { MAX_WS_CONNECTIONS, MAX_WS_MESSAGE_BYTES, MAX_WS_QUEUE_BYTES, WS_HEARTBEAT_MS, WS_PONG_TIMEOUT_MS } = require('./config.js');

// ── WebSocket 桥接（手机 WS → 隧道 → 上游 WS）───────────────────────
function sendWsFrame(inst, id, frame) {
  return sendTunnelFrame(inst, frame.isBinary ? T.wsBinary : T.wsText, id, frame.data);
}
function handlePhoneWs(ws, req, inst) {
  let wsCount = 0;
  for (const candidate of inst.pending.values()) if (candidate.kind === 'ws') wsCount += 1;
  if (wsCount >= MAX_WS_CONNECTIONS || !pendingCapacity(inst, 'ws')) {
    try { ws.close(1013, 'relay resource limit exceeded'); } catch { /* ignore */ }
    return;
  }
  const id = allocTunnelId(inst);
  const entry = { kind: 'ws', phone: ws, ready: false, queued: [], queuedBytes: 0 };
  inst.pending.set(id, entry);
  // 半开判定用的活性时间戳：pong 或任何上行帧都算「这条链路还活着」。
  let lastPong = Date.now();
  ws.on('message', (data, isBinary) => {
    lastPong = Date.now();
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    if (bytes > MAX_WS_MESSAGE_BYTES || (!entry.ready && entry.queuedBytes + bytes > MAX_WS_QUEUE_BYTES)) {
      try { ws.close(1009, 'message too large'); } catch { /* ignore */ }
      return;
    }
    if (!entry.ready) {
      entry.queued.push({ data, isBinary });
      entry.queuedBytes += bytes;
      return;
    }
    // 此前判的是 ws.bufferedAmount（relay→手机 方向），与手机上行无关；
    // 且 sendWsFrame 的失败被忽略，隧道压满时静默丢帧。
    // 现在按真实方向处理：隧道写不进去就断开这条手机 WS，而不是 terminate 整条隧道。
    if (!sendWsFrame(inst, id, { data, isBinary })) {
      try { ws.close(1013, 'relay buffer limit exceeded'); } catch { /* ignore */ }
    }
  });
  ws.on('close', (code, reason) => {
    clearInterval(entry.pingTimer);
    if (inst.pending.get(id) === entry) inst.pending.delete(id);
    sendTunnelFrame(inst, T.wsClose, id, encodeClosePayload(code, reason));
  });
  ws.on('error', () => {});
  ws.on('pong', () => { lastPong = Date.now(); });
  // 保活：CDN/nginx 可能对空闲的 WebSocket 超时断开（曾观察到每 30s 断线重连）。
  // 定期向手机侧发 ping 帧（浏览器/RN 的 WebSocket 由底层自动回 pong），让链路保持活跃。
  //
  // 光发 ping 不够：对端消失或 NAT 超时时这条连接会一直停在 OPEN（半开），它永久占着
  // pending 名额（MAX_PENDING_PER_INSTANCE=128）与 MAX_WS_CONNECTIONS，手机重连还会继续
  // 被拒。所以照隧道心跳（server.js 的 TUNNEL_HEARTBEAT_MS/TUNNEL_PONG_TIMEOUT_MS）补上
  // pong 超时：超时就 terminate 这条手机 WS —— close 处理器会清掉 pending 并向上游发
  // wsClose，隧道本身不动。任何上行帧也算活性，避免「安静但健康」的连接被误杀。
  entry.pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > WS_PONG_TIMEOUT_MS) {
      log(`phone ws heartbeat timeout, terminating: instance=${inst.instanceId} id=${id} (>${WS_PONG_TIMEOUT_MS}ms)`);
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    try { ws.ping(); } catch { /* ignore */ }
  }, WS_HEARTBEAT_MS);
  if (!sendTunnelFrame(inst, T.wsUpgrade, id, JSON.stringify({ path: req.url, headers: pickForwardHeaders(req.headers) }))) {
    clearInterval(entry.pingTimer);
    inst.pending.delete(id);
    ws.close(1011, 'tunnel unavailable');
  }
}

module.exports = {
  handlePhoneWs,
  sendWsFrame,
};
