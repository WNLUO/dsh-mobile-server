'use strict';

/**
 * 参考隧道实现（协议 v2）：把「中转服务器」与「本地 HTTP/WS 服务」对接起来。
 *
 * 宿主插件的 lib/relay/tunnel.js（class RelayTunnel）按本文件逻辑实现：
 *  1. 连接 wss://<relay>/tunnel
 *  2. 发送 register 帧（instanceId + pairingCode + name）
 *  3. 处理中转发来的 httpRequest / wsUpgrade 帧，转发到本地 127.0.0.1:<port>
 *  4. 把上游响应以 httpHead / httpChunk / httpEnd / wsText / wsBinary 回传
 *
 * 协议见 ../PROTOCOL.md（v2 章节），帧编解码见 ../lib/protocol.js。
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
   * @param {string} opts.instanceId
   * @param {string} opts.pairingCode
   * @param {string} [opts.name]
   * @param {string} opts.upstream  本地上游地址，如 http://127.0.0.1:port
   * @param {(msg: string)=>void} [opts.onLog]
   */
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.instanceId = opts.instanceId;
    this.pairingCode = opts.pairingCode;
    this.name = opts.name || '';
    this.lanUrls = opts.lanUrls || [];
    this.lanCandidates = opts.lanCandidates || [];
    this.upstream = new URL(opts.upstream);
    this.onLog = opts.onLog || (() => {});
    /** 收到 pairRequest 时是否自动批准（模拟桌面用户点"允许"）；可传 onPairRequest 覆盖 */
    this.autoApprovePair = opts.autoApprovePair !== false;
    this.onPairRequest = opts.onPairRequest || null;
    this.ws = null;
    this.wsClients = new Map();  // relay 侧 ws id -> 上游 ws client
    this.reqClients = new Map(); // relay 侧 http id -> 上游 http request
  }

  log(...args) {
    this.onLog(`[desktop-tunnel ${this.instanceId}]`, ...args);
  }

  sendFrame(type, id, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame(type, id, payload));
    }
  }
  sendJson(type, id, obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(jsonFrame(type, id, obj));
    }
  }

  /** 更新配对码：先更新本地，再经已建立的隧道通知中转（旧码即刻失效）。 */
  updatePairingCode(code) {
    this.pairingCode = code;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson(T.updatePairing, 0, { pairingCode: code });
    }
  }

  /** 连接中转并注册实例；resolve 于收到 registered 回执 */
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (!settled) {
          settled = true;
          fn(arg);
        }
      };
      const ws = new WebSocket(`${this.relayUrl}/tunnel`, { perMessageDeflate: true });
      this.ws = ws;
      const timer = setTimeout(() => {
        done(reject, new Error('register timeout'));
        try { ws.close(); } catch { /* ignore */ }
      }, 8000);
      const push = createFrameDecoder((frame) => {
        if (frame.type === T.registered) {
          clearTimeout(timer);
          done(resolve);
          this.log('registered');
          return;
        }
        this.handleFrame(frame);
      });
      ws.on('open', () => {
        this.sendJson(T.register, 0, {
          instanceId: this.instanceId,
          pairingCode: this.pairingCode,
          name: this.name,
          lanUrls: this.lanUrls || [],
          lanCandidates: this.lanCandidates || [],
        });
      });
      ws.on('message', (data, isBinary) => push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.log(`tunnel closed: ${code} ${reason}`);
        this.ws = null;
        for (const [, client] of this.wsClients) {
          try { client.terminate(); } catch { /* ignore */ }
        }
        this.wsClients.clear();
        for (const [, req] of this.reqClients) {
          try { req.destroy(); } catch { /* ignore */ }
        }
        this.reqClients.clear();
        done(reject, new Error(`隧道关闭: ${code} ${reason}`));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        done(reject, err);
      });
    });
  }

  stop() {
    for (const [, client] of this.wsClients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    for (const [, req] of this.reqClients) {
      try { req.destroy(); } catch { /* ignore */ }
    }
    this.reqClients.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  handleFrame(frame) {
    const { type, id, payload } = frame;
    switch (type) {
      case T.httpRequest: {
        const msg = parseJson(payload);
        const req = http.request(
          {
            host: this.upstream.hostname,
            port: this.upstream.port,
            method: msg.method,
            path: msg.path,
            headers: {
              ...(msg.headers || {}),
              // 保留手机端原始 Host（信任围栏按 Host 判定）；缺省回退本地上游
              host: (msg.headers && msg.headers.host) || this.upstream.host,
            },
          },
          (res) => {
            this.sendJson(T.httpHead, id, { status: res.statusCode, headers: res.headers });
            res.on('data', (c) => this.sendFrame(T.httpChunk, id, c));
            res.on('end', () => this.sendFrame(T.httpEnd, id, Buffer.alloc(0)));
            res.on('error', (err) => this.sendJson(T.httpError, id, { message: err.message }));
          },
        );
        this.reqClients.set(id, req);
        req.on('error', (err) => {
          this.reqClients.delete(id);
          this.sendJson(T.httpError, id, { message: err.message });
        });
        break;
      }
      case T.httpBody: {
        const req = this.reqClients.get(id);
        if (!req) break;
        if (payload.length === 0) {
          this.reqClients.delete(id);
          try { req.end(); } catch { /* ignore */ }
        } else {
          try { req.write(payload); } catch { /* ignore */ }
        }
        break;
      }
      case T.wsUpgrade: {
        const msg = parseJson(payload);
        this.forwardWs(id, msg.path, msg.headers);
        break;
      }
      case T.wsText:
      case T.wsBinary: {
        const client = this.wsClients.get(id);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(payload, { binary: type === T.wsBinary });
        }
        break;
      }
      case T.wsClose: {
        const client = this.wsClients.get(id);
        if (client) {
          this.wsClients.delete(id);
          try { client.close(codeFromPayload(payload)); } catch { /* ignore */ }
        }
        break;
      }
      case T.pairRequest: {
        const msg = parseJson(payload);
        if (this.onPairRequest) {
          this.onPairRequest(msg);
          break;
        }
        if (this.autoApprovePair) {
          this.sendJson(T.pairConfirm, 0, {
            requestId: msg.requestId,
            approved: true,
            token: `test-token-${this.instanceId}`,
          });
        }
        break;
      }
      case T.ping:
        this.sendFrame(T.pong, 0, Buffer.alloc(0));
        break;
      default:
        break;
    }
  }

  /** 把手机发来的 WS 升级请求桥接到本地上游 WS */
  forwardWs(id, path, headers) {
    const url = `ws://${this.upstream.host}${path}`;
    let client;
    try {
      client = new WebSocket(url, { headers });
    } catch (err) {
      this.sendJson(T.wsError, id, { message: err.message });
      return;
    }
    this.wsClients.set(id, client);
    client.on('open', () => this.sendFrame(T.wsOpen, id, Buffer.alloc(0)));
    client.on('message', (data, isBinary) =>
      this.sendFrame(isBinary ? T.wsBinary : T.wsText, id, data),
    );
    client.on('close', (code) => this.sendFrame(T.wsClose, id, encodeCloseCode(code)));
    client.on('error', (err) => {
      this.sendJson(T.wsError, id, { message: err.message });
      this.wsClients.delete(id);
    });
  }
}

// ── CLI 模式：手动联调用 ────────────────────────────────────────────
// node test/fake-desktop.js --relay ws://127.0.0.1:8700 --id smoke01 \
//      --code 123456 --name "Mac mini" --upstream http://127.0.0.1:9000
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const tunnel = new RelayTunnel({
    relayUrl: get('--relay', 'ws://127.0.0.1:8700'),
    instanceId: get('--id', 'smoke01'),
    pairingCode: get('--code', '123456'),
    name: get('--name', ''),
    upstream: get('--upstream', 'http://127.0.0.1:9000'),
    onLog: (...a) => console.log(...a),
  });
  tunnel
    .start()
    .then(() => console.log('tunnel ready. Ctrl+C to stop.'))
    .catch((e) => {
      console.error('tunnel failed:', e.message);
      process.exit(1);
    });
}

module.exports = { RelayTunnel };
