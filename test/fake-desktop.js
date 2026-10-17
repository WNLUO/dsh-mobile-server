'use strict';

/**
 * 参考隧道实现（协议 v2）：把「中转服务器」与「本地 HTTP/WS 服务」对接起来。
 *
 * 宿主插件的 lib/relay/tunnel.js（class RelayTunnel）按本文件逻辑实现：
 *  1. 连接 wss://<relay>/tunnel
 *  2. 处理中转发来的 httpRequest / wsUpgrade 帧，转发到本地 127.0.0.1:<port>
 *  3. 把上游响应以 httpHead / httpChunk / httpEnd / wsText / wsBinary 回传
 *
 * 自建版中转不再要求任何注册帧：连上 /tunnel 就是那条隧道。协议见 ../PROTOCOL.md
 * （v2 章节），帧编解码见 ../lib/protocol.js。
 */

const http = require('node:http');
const { WebSocket } = require('ws');
const { T, jsonFrame, encodeFrame, createFrameDecoder, parseJson } = require('../lib/protocol.js');

function encodeCloseCode(code) {
  const valid = Number.isInteger(code) && code >= 1000 && code <= 4999;
  const c = valid ? code : 1000;
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(c, 0);
  return b;
}
function codeFromPayload(payload) {
  if (!payload || payload.length < 2) return 1000;
  const c = payload.readUInt16BE(0);
  return Number.isInteger(c) && c >= 1000 && c <= 4999 ? c : 1000;
}

class RelayTunnel {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl  如 ws://127.0.0.1:8700
   * @param {string} opts.upstream  本地上游地址，如 http://127.0.0.1:port
   * @param {(msg: string)=>void} [opts.onLog]
   */
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.upstream = new URL(opts.upstream);
    this.onLog = opts.onLog || (() => {});
    this.ws = null;
    this.wsClients = new Map();  // relay 侧 ws id -> 上游 ws client
    this.reqClients = new Map(); // relay 侧 http id -> { req, res, headSent }
  }

  log(...args) {
    this.onLog('[host-tunnel]', ...args);
  }

  sendFrame(type, id, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame(type, id, payload));
    }
  }
  sendJson(type, id, obj) {
    this.sendFrame(type, id, JSON.stringify(obj));
  }

  /** 建隧道；resolve 时握手完成（宿主可以开始收帧）。 */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.relayUrl.replace(/\/+$/, '')}/tunnel`);
      this.ws = ws;
      const push = createFrameDecoder((frame) => this.handleFrame(frame), { onError: () => {} });
      ws.on('open', () => {
        this.log('connected');
        resolve();
      });
      ws.on('message', (data) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      ws.on('error', (err) => reject(err));
      ws.on('close', (code, reason) => this.log(`closed code=${code} reason=${reason || ''}`));
    });
  }

  close() {
    for (const [, client] of this.reqClients) {
      try { client.req.destroy(); } catch { /* ignore */ }
      try { if (!client.res.destroyed) client.res.destroy(); } catch { /* ignore */ }
    }
    this.reqClients.clear();
    for (const [, client] of this.wsClients) {
      try { client.close(1000, 'tunnel closed'); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch { /* ignore */ }
    }
  }

  handleFrame(frame) {
    const { type, id, payload } = frame;
    if (type === T.ping) {
      this.sendFrame(T.pong, 0, Buffer.alloc(0));
      return;
    }
    if (type === T.pong) return;
    if (type === T.httpRequest) return this.onHttpRequest(id, parseJson(payload));
    if (type === T.httpBody) return this.onHttpBody(id, payload);
    if (type === T.httpCancel) return this.onHttpCancel(id);
    if (type === T.httpPause) return this.onHttpPause(id);
    if (type === T.httpResume) return this.onHttpResume(id);
    if (type === T.wsUpgrade) return this.onWsUpgrade(id, parseJson(payload));
    if (type === T.wsText || type === T.wsBinary) return this.onWsData(id, payload, type === T.wsBinary);
    if (type === T.wsClose) return this.onWsClose(id, codeFromPayload(payload));
  }

  // ── HTTP ──────────────────────────────────────────────────────────
  onHttpRequest(id, msg) {
    const headers = { ...(msg.headers || {}) };
    delete headers.host;
    const req = http.request({
      host: this.upstream.hostname,
      port: this.upstream.port,
      method: msg.method,
      path: msg.path,
      headers,
    });
    const client = { req, res: null, headSent: false };
    this.reqClients.set(id, client);
    req.on('response', (res) => {
      client.res = res;
      this.sendJson(T.httpHead, id, { status: res.statusCode, headers: res.headers });
      client.headSent = true;
      res.on('data', (chunk) => this.sendFrame(T.httpChunk, id, chunk));
      res.on('end', () => {
        this.reqClients.delete(id);
        this.sendFrame(T.httpEnd, id, Buffer.alloc(0));
      });
      res.on('error', (err) => this.failHttp(id, err));
    });
    req.on('error', (err) => this.failHttp(id, err));
  }

  onHttpBody(id, payload) {
    const client = this.reqClients.get(id);
    if (!client) return;
    if (payload.length === 0) {
      client.req.end();
      return;
    }
    client.req.write(Buffer.from(payload));
  }

  onHttpCancel(id) {
    const client = this.reqClients.get(id);
    if (!client) return;
    this.reqClients.delete(id);
    try { client.req.destroy(); } catch { /* ignore */ }
    try { if (client.res && !client.res.destroyed) client.res.destroy(); } catch { /* ignore */ }
  }

  onHttpPause(id) {
    const client = this.reqClients.get(id);
    if (client && client.res) client.res.pause();
  }

  onHttpResume(id) {
    const client = this.reqClients.get(id);
    if (client && client.res) client.res.resume();
  }

  failHttp(id, err) {
    if (!this.reqClients.has(id)) return;
    this.reqClients.delete(id);
    this.sendJson(T.httpError, id, { message: err && err.message ? err.message : String(err) });
  }

  // ── WebSocket ─────────────────────────────────────────────────────
  onWsUpgrade(id, msg) {
    const target = new URL(msg.path, this.upstream);
    const headers = { ...(msg.headers || {}) };
    delete headers.host;
    const ws = new WebSocket(target, { headers });
    this.wsClients.set(id, ws);
    ws.on('open', () => this.sendFrame(T.wsOpen, id, Buffer.alloc(0)));
    ws.on('message', (data, isBinary) => this.sendFrame(isBinary ? T.wsBinary : T.wsText, id, data));
    ws.on('close', (code, reason) => {
      if (!this.wsClients.has(id)) return;
      this.wsClients.delete(id);
      this.sendFrame(T.wsClose, id, Buffer.concat([
        encodeCloseCode(code),
        Buffer.from(String(reason || '').slice(0, 100), 'utf8'),
      ]));
    });
    ws.on('error', (err) => {
      if (!this.wsClients.has(id)) return;
      this.wsClients.delete(id);
      this.sendJson(T.wsError, id, { message: err && err.message ? err.message : String(err) });
    });
  }

  onWsData(id, payload, isBinary) {
    const ws = this.wsClients.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(payload, { binary: isBinary }); } catch { /* ignore */ }
  }

  onWsClose(id, code) {
    const ws = this.wsClients.get(id);
    if (!ws) return;
    this.wsClients.delete(id);
    try { ws.close(code); } catch { /* ignore */ }
  }
}

module.exports = { RelayTunnel };
