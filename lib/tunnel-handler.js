'use strict';

/**
 * 隧道帧分发：把宿主经隧道推回来的帧分发给等待中的 HTTP 响应 / 手机 WS。
 *
 * 依赖方向：protocol + tunnel（log）+ proxy-http + bridge-ws。
 *
 * 只认「转发」用得上的帧：http*（一次 HTTP 往返）与 ws*（一条手机 WS 的桥接），
 * ping/pong 由 server.js 在心跳那一层直接处理。曾经的配对、镜像推送、设备吊销
 * 都随自建版精简一起删掉了（见 docs/decisions.md 2026-10-16）。
 */

const { WebSocket } = require('ws');
const { T, parseJson, decodeClosePayload } = require('./protocol.js');
const { log } = require('./tunnel.js');
const { sanitizeRespHeaders, sendTunnelFrame, armSseIdle } = require('./proxy-http.js');
const { sendWsFrame } = require('./bridge-ws.js');

/**
 * 隧道断开（或被新连接取代）时，把这条隧道上还没结束的请求一次性失败掉。
 *
 * 不清理的后果是这些条目永久留在 `pending` 里：HTTP 响应永不 end、手机 WS 停在 OPEN，
 * 客户端只能等自己的超时。聊天页的 SSE 会因此挂满 600s。
 */
function failAllPending(tunnel, reason) {
  for (const [, entry] of tunnel.pending) {
    if (entry.kind === 'http') {
      if (entry.headerTimer) clearTimeout(entry.headerTimer);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try {
        entry.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        entry.res.end(`upstream unavailable: ${reason}`);
      } catch {
        try { entry.res.destroy?.(); } catch { /* ignore */ }
      }
    } else if (entry.kind === 'ws') {
      if (entry.pingTimer) clearInterval(entry.pingTimer);
      if (entry.phone.readyState === WebSocket.OPEN) {
        try { entry.phone.close(1011, reason); } catch {
          try { entry.phone.terminate?.(); } catch { /* ignore */ }
        }
      }
    }
  }
  tunnel.pending.clear();
}

function handleTunnelFrame(tunnel, frame) {
  try {
    handleTunnelFrameInner(tunnel, frame);
  } catch (err) {
    // 单条消息异常不得拖垮整个 relay 进程
    log('tunnel frame error:', err.message);
  }
}

function handleTunnelFrameInner(tunnel, frame) {
  const { type, id, payload } = frame;
  const entry = tunnel.pending.get(id);
  switch (type) {
    case T.httpHead: {
      if (!entry || entry.kind !== 'http' || entry.started || entry.cancelled) return;
      const msg = parseJson(payload);
      entry.started = true;
      if (entry.headerTimer) clearTimeout(entry.headerTimer);
      entry.res.writeHead(msg.status || 502, sanitizeRespHeaders(msg.headers));
      armSseIdle(tunnel, id, entry);
      break;
    }
    case T.httpChunk: {
      if (!entry || entry.kind !== 'http' || !entry.started || entry.cancelled) return;
      const writable = entry.res.write(payload);
      armSseIdle(tunnel, id, entry);
      if (!writable && !entry.paused) {
        // 手机读得比宿主推得慢：让宿主先停下，等 drain 再放行（见 proxy-http 的 res.on('drain')）。
        entry.paused = true;
        sendTunnelFrame(tunnel, T.httpPause, id, Buffer.alloc(0));
      }
      break;
    }
    case T.httpEnd: {
      if (!entry || entry.kind !== 'http') return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      tunnel.pending.delete(id);
      try { entry.res.end(); } catch { /* ignore */ }
      break;
    }
    case T.httpError: {
      if (!entry) return;
      if (entry.headerTimer) clearTimeout(entry.headerTimer);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      tunnel.pending.delete(id);
      if (entry.kind === 'http') {
        const msg = parseJson(payload);
        try {
          if (!entry.started) entry.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          entry.res.end(`upstream error: ${msg.message || ''}`);
        } catch { /* ignore */ }
      } else if (entry.phone.readyState === WebSocket.OPEN) {
        const msg = parseJson(payload);
        entry.phone.close(1011, msg.message || 'upstream error');
      }
      break;
    }
    case T.wsOpen: {
      if (!entry || entry.kind !== 'ws' || entry.ready) return;
      entry.ready = true;
      // 未 ready 期间排队的上行帧必须在这一刻冲出去。忽略 sendWsFrame 的返回值会让
      // 这些帧在隧道压满时静默消失，手机侧只看到「连上了但第一条消息没到」，日志里
      // 一行都没有。写不进去就断开这条手机 WS，让客户端重连重发。
      let delivered = true;
      for (const q of entry.queued) {
        if (!sendWsFrame(tunnel, id, q)) { delivered = false; break; }
      }
      const queuedBytes = entry.queuedBytes;
      entry.queued = [];
      entry.queuedBytes = 0;
      if (!delivered) {
        log(`ws open queue flush failed: id=${id} queuedBytes=${queuedBytes}`);
        tunnel.pending.delete(id);
        try { entry.phone.close(1013, 'relay buffer limit exceeded'); } catch { /* ignore */ }
      }
      break;
    }
    case T.wsText:
    case T.wsBinary: {
      if (!entry || entry.kind !== 'ws' || entry.phone.readyState !== WebSocket.OPEN) return;
      if (Number(entry.phone.bufferedAmount || 0) > 16 * 1024 * 1024) {
        try { entry.phone.close(1013, 'relay buffer limit exceeded'); } catch { /* ignore */ }
        tunnel.pending.delete(id);
        return;
      }
      try { entry.phone.send(payload, { binary: type === T.wsBinary }); } catch {
        try { entry.phone.terminate(); } catch { /* ignore */ }
      }
      break;
    }
    case T.wsClose: {
      if (!entry || entry.kind !== 'ws') return;
      tunnel.pending.delete(id);
      // 上游可能传非法/缺失 code（曾导致 close(NaN) 崩溃整个 relay）
      const { code, raw, reason, validCode } = decodeClosePayload(payload);
      if (!validCode) log(`wsClose 收到非法 code: ${raw}`);
      if (entry.phone.readyState === WebSocket.OPEN) entry.phone.close(code, reason);
      break;
    }
    case T.wsError: {
      // 宿主侧 WS 升级/传输失败。没有这个分支时帧被 default 静默丢弃，手机的 socket
      // 会一直挂到超时，并且 pending 条目不回收。
      if (!entry || entry.kind !== 'ws') return;
      tunnel.pending.delete(id);
      const msg = parseJson(payload) || {};
      const reason = String(msg.message || 'upstream websocket error').slice(0, 120);
      try {
        if (entry.phone.readyState === WebSocket.OPEN) entry.phone.close(1011, reason);
        else entry.phone.terminate();
      } catch { /* ignore */ }
      break;
    }
    default:
      break;
  }
}

module.exports = {
  failAllPending,
  handleTunnelFrame,
};
