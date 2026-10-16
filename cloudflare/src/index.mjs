/** Cloudflare Worker entrypoint and protocol-v2 relay implementation. */
const INSTANCE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WS_QUEUE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const REQUEST_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control', 'content-type', 'if-none-match', 'if-modified-since', 'origin', 'user-agent', 'x-request-id', 'x-dsh-device-credential']);
const RESPONSE_HEADERS = new Set(['cache-control', 'content-encoding', 'content-language', 'content-length', 'content-type', 'etag', 'expires', 'last-modified', 'location', 'retry-after', 'x-accel-buffering']);
const RELAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>DSH 中转</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#18212f;background:#f3f6fb;font-synthesis:none;text-rendering:optimizeLegibility}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;padding:32px 18px;display:grid;place-items:center}
    main{width:min(100%,640px);padding:32px;border:1px solid #dce3ed;border-radius:20px;background:#fff;box-shadow:0 16px 50px #1a2a4012}
    .brand{margin:0 0 10px;color:#536b91;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    h1{margin:0;font-size:30px;letter-spacing:-.03em}.intro{margin:10px 0 24px;color:#59677a;line-height:1.6}
    .status{display:grid;gap:12px;padding:18px;border-radius:14px;background:#f4f7fb}.row{display:flex;align-items:center;justify-content:space-between;gap:16px}
    .label{color:#59677a}.value{font-weight:700}.good{color:#16834a}.bad{color:#b54735}.muted{color:#68778b}
    .address{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:12px 14px;border:1px solid #e0e6ef;border-radius:12px}
    code{overflow-wrap:anywhere;color:#263850}.copy{flex:none;border:0;border-radius:9px;padding:9px 12px;background:#315fca;color:#fff;font:inherit;font-weight:650;cursor:pointer}
    h2{margin:26px 0 10px;font-size:16px}.steps{margin:0;padding-left:22px;color:#46566b;line-height:1.7}.note{margin:18px 0 0;padding-top:16px;border-top:1px solid #e5eaf1;color:#69778a;font-size:13px;line-height:1.6}
    @media(prefers-color-scheme:dark){:root{color:#e6ebf3;background:#111722}main{background:#1b2431;border-color:#354154;box-shadow:none}.brand{color:#9cb8ef}.intro,.label,.steps,.note{color:#b3bfd0}.status{background:#222e3e}.address{border-color:#354154}code{color:#e0e8f5}}
  </style>
</head>
<body>
  <main>
    <p class="brand">DSH · Cloudflare Relay</p>
    <h1>你的中转已部署</h1>
    <p class="intro">这里是你自己的 DSH 中转入口。此页只显示服务和桌面隧道是否在线，不展示实例、设备或密钥信息。</p>
    <section class="status" aria-label="服务状态" aria-live="polite">
      <div class="row"><span class="label">中转服务</span><strong id="relay-state" class="value muted">检查中…</strong></div>
      <div class="row"><span class="label">桌面隧道</span><strong id="host-state" class="value muted">检查中…</strong></div>
    </section>
    <div class="address"><code id="relay-url"></code><button id="copy-url" class="copy" type="button">复制地址</button></div>
    <h2>开始使用</h2>
    <ol class="steps">
      <li>把上面的地址填入 DSH 桌面端插件的中转地址。</li>
      <li>若在 Cloudflare 设置了注册密钥，也要在桌面端填入相同密钥。</li>
      <li>打开手机 App 按配对流程连接；配对请求仍由桌面端处理。</li>
    </ol>
    <p class="note">部署、密钥和运行日志可在 Cloudflare Dashboard 管理。部署或断线会中断正在进行的请求，桌面端重连后即可继续使用。不要把密钥发给他人。</p>
  </main>
  <script>
    const relayState = document.querySelector('#relay-state');
    const hostState = document.querySelector('#host-state');
    document.querySelector('#relay-url').textContent = location.origin;
    document.querySelector('#copy-url').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(location.origin); button.textContent = '已复制'; }
      catch { button.textContent = '请手动复制地址'; }
    });
    fetch('/status', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('status unavailable');
      const status = await response.json();
      relayState.textContent = '在线'; relayState.className = 'value good';
      hostState.textContent = status.hostConnected ? '已连接' : '未连接';
      hostState.className = status.hostConnected ? 'value good' : 'value bad';
    }).catch(() => {
      relayState.textContent = '暂时无法读取'; relayState.className = 'value bad';
      hostState.textContent = '状态未知'; hostState.className = 'value muted';
    });
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response(RELAY_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (url.pathname === '/healthz') return new Response('ok');
    return env.RELAY.get(env.RELAY.idFromName('relay')).fetch(request);
  },
};

export class RelayInstance {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pendingPairs = new Map();
    this.pendingHttp = new Map();
    this.pendingWs = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status' && request.method === 'GET') {
      const hostConnected = this.state.getWebSockets('host').some((socket) => {
        const attachment = socket.deserializeAttachment() || {};
        return attachment.registered && (!('readyState' in socket) || socket.readyState < 2);
      });
      return json({ ok: true, hostConnected }, 200, { 'cache-control': 'no-store' });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (url.pathname === '/tunnel') {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.state.acceptWebSocket(server, ['host']);
        return new Response(null, { status: 101, webSocket: client });
      }
      return this.upgradePhone(request, url);
    }
    if ((url.pathname === '/pair' || /^\/r\/[^/]+\/pair$/.test(url.pathname)) && request.method === 'POST') return this.pair(request, url);
    if (url.pathname === '/api/mobile/v1/device-credential/revoke' && request.method === 'POST') return this.revokeCredential(request);
    if (url.pathname === '/api/mobile/v1/connection-info' && request.method === 'GET') return this.connectionInfo(request);
    if (url.pathname.startsWith('/api/mobile/')) return this.proxyMobile(request, url);
    return json({ ok: false, error: 'endpoint not found' }, 404);
  }

  webSocketMessage(socket, message) {
    if (this.state.getTags(socket).includes('phone')) {
      const attachment = socket.deserializeAttachment() || {};
      const entry = this.wsEntry(attachment.id);
      if (!entry) return socket.close(1011, 'upstream websocket unavailable');
      const bytes = typeof message === 'string' ? encoder.encode(message) : new Uint8Array(message);
      if (bytes.byteLength > MAX_WS_MESSAGE_BYTES) return socket.close(1009, 'message too large');
      if ((entry.host.bufferedAmount || 0) + bytes.byteLength + 9 > MAX_WS_QUEUE_BYTES) return socket.close(1013, 'relay buffer limit exceeded');
      try { entry.host.send(encodeFrame(typeof message === 'string' ? 0x0d : 0x0e, attachment.id, bytes)); }
      catch { socket.close(1013, 'upstream websocket unavailable'); }
      return;
    }
    if (typeof message === 'string') return socket.close(1003, 'binary frames required');
    const frames = [];
    try { new FrameDecoder((frame) => frames.push(frame)).push(message); }
    catch { socket.close(1002, 'invalid protocol frame'); return; }
    const processing = (async () => {
      for (const frame of frames) await this.onFrame(socket, frame);
    })().catch(() => socket.close(1011, 'relay processing failed'));
    this.state.waitUntil(processing);
    return processing;
  }

  webSocketClose(socket, code, reason) {
    if (this.state.getTags(socket).includes('host')) this.cleanupHost(socket, 'host disconnected');
    if (this.state.getTags(socket).includes('phone')) {
      const attachment = socket.deserializeAttachment() || {};
      const host = this.pendingWs.get(attachment.id)?.host || this.hostFor(attachment.instanceId);
      if (host) {
        try { host.send(encodeFrame(0x0f, attachment.id, encodeClosePayload(code, reason))); } catch {}
        this.pendingWs.delete(attachment.id);
      }
    }
  }
  webSocketError(socket) { if (this.state.getTags(socket).includes('host')) this.cleanupHost(socket, 'host connection error'); }

  cleanupHost(socket, reason) {
    const instanceId = (socket.deserializeAttachment() || {}).instanceId;
    for (const phone of this.state.getWebSockets('phone')) {
      const attachment = phone.deserializeAttachment() || {};
      if (attachment.instanceId === instanceId) phone.close(1011, reason);
    }
    for (const [requestId, pending] of this.pendingPairs) {
      if (pending.host !== socket) continue;
      clearTimeout(pending.timer);
      this.pendingPairs.delete(requestId);
      pending.resolve(json({ ok: false, error: reason }, 503));
    }
    for (const [id, pending] of this.pendingHttp) {
      if (pending.host !== socket) continue;
      pending.resolveHead({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      pending.ended = true;
      if (pending.idleTimer) clearTimeout(pending.idleTimer);
      pending.finish();
      if (pending.controller) pending.controller.error(new Error(reason));
      this.pendingHttp.delete(id);
    }
    for (const [id, pending] of this.pendingWs) {
      if (pending.host !== socket) continue;
      pending.resolveOpen(false);
      pending.phone.close(1011, reason);
      this.pendingWs.delete(id);
    }
  }

  hostFor(instanceId) {
    return this.state.getWebSockets('host').find((socket) => {
      const attachment = socket.deserializeAttachment() || {};
      return attachment.registered && attachment.instanceId === instanceId && (!('readyState' in socket) || socket.readyState < 2);
    }) || null;
  }

  wsEntry(id) {
    const active = this.pendingWs.get(id);
    if (active) return active;
    const phone = this.state.getWebSockets('phone').find((socket) => (socket.deserializeAttachment() || {}).id === id);
    if (!phone) return null;
    const attachment = phone.deserializeAttachment() || {};
    const host = this.hostFor(attachment.instanceId);
    if (!host) return null;
    const entry = { host, phone, resolveOpen: () => {} };
    this.pendingWs.set(id, entry);
    return entry;
  }

  async onFrame(socket, frame) {
    const attachment = socket.deserializeAttachment() || {};
    if (frame.type === 0x01) {
      const registration = parseJson(frame.payload);
      if (!INSTANCE_ID.test(registration.instanceId || '') || !/^\d{6}$/.test(String(registration.pairingCode || '')) || (registration.name != null && (typeof registration.name !== 'string' || registration.name.length > 128))) return socket.close(1008, 'bad registration');
      if (this.env.TUNNEL_REGISTER_SECRET && !safeEqual(registration.secret, this.env.TUNNEL_REGISTER_SECRET)) return socket.close(1008, 'bad register secret');
      const replaced = this.hostFor(registration.instanceId);
      if (replaced && replaced !== socket) {
        const previous = replaced.deserializeAttachment() || {};
        if (previous.pairingCode !== registration.pairingCode) return socket.close(1008, 'bad pairing code');
        this.cleanupHost(replaced, 'replaced');
        replaced.close(1001, 'replaced');
      }
      socket.serializeAttachment({ instanceId: registration.instanceId, pairingCode: String(registration.pairingCode || ''), registered: true, name: registration.name || '' });
      socket.send(encodeFrame(0x02, 0, {}));
      return;
    }
    if (!attachment.registered) return socket.close(1008, 'register first');
    if (frame.type === 0x03) {
      const { pairingCode } = parseJson(frame.payload);
      if (/^\d{6}$/.test(String(pairingCode || ''))) socket.serializeAttachment({ ...attachment, pairingCode: String(pairingCode) });
      return;
    }
    if (frame.type === 0x10) {
      socket.send(encodeFrame(0x11, 0, new Uint8Array()));
      return;
    }
    if (frame.type === 0x13) return this.onPairConfirm(socket, frame);
    if (frame.type === 0x18) return this.revokeAll(socket);
    const ws = this.wsEntry(frame.id);
    if (ws?.host === socket) {
      if (frame.type === 0x0b) { ws.resolveOpen(true); return; }
      if (frame.type === 0x0c) { ws.resolveOpen(false); this.pendingWs.delete(frame.id); return; }
      if (frame.type === 0x0d || frame.type === 0x0e) {
        if (frame.payload.byteLength > MAX_WS_MESSAGE_BYTES) { ws.phone.close(1009, 'message too large'); this.pendingWs.delete(frame.id); return; }
        if ((ws.phone.bufferedAmount || 0) + frame.payload.byteLength > MAX_WS_QUEUE_BYTES) { ws.phone.close(1013, 'relay buffer limit exceeded'); this.pendingWs.delete(frame.id); return; }
        const data = frame.type === 0x0d ? new TextDecoder().decode(frame.payload) : frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength);
        ws.phone.send(data);
        return;
      }
      if (frame.type === 0x0f) {
        const [code, reason] = decodeClosePayload(frame.payload);
        ws.phone.close(code, reason);
        this.pendingWs.delete(frame.id);
        return;
      }
    }
    const pending = this.pendingHttp.get(frame.id);
    if (pending?.host === socket) this.onHttpFrame(pending, frame);
  }

  async revokeAll(socket) {
    const instanceId = (socket.deserializeAttachment() || {}).instanceId;
    const credentials = await this.state.storage.list({ prefix: 'credential:' });
    let revoked = 0;
    const revokedAt = Date.now();
    for (const [key, record] of credentials) {
      if (record.instanceId !== instanceId || record.revokedAt) continue;
      await this.state.storage.put(key, { ...record, revokedAt });
      revoked += 1;
    }
    socket.send(encodeFrame(0x19, 0, { ok: true, revoked }));
  }

  async upgradePhone(request, url) {
    const auth = await this.authenticate(request);
    if (!auth) return new Response('unauthorized', { status: 401 });
    const host = this.hostFor(auth.instanceId);
    if (!host) return new Response('upstream unavailable', { status: 502 });
    const count = this.state.getWebSockets('phone').filter((socket) => (socket.deserializeAttachment() || {}).instanceId === auth.instanceId).length;
    if (count >= 256) return new Response('relay resource limit exceeded', { status: 503 });
    const id = await this.allocateId();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, ['phone']);
    server.serializeAttachment({ kind: 'phone', instanceId: auth.instanceId, id });
    const openPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      this.pendingWs.set(id, { host, phone: server, resolveOpen: (ok) => { clearTimeout(timer); resolve(ok); } });
    });
    const headers = {};
    for (const [name, value] of request.headers) if (REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    try { host.send(encodeFrame(0x0a, id, { path: `${url.pathname}${url.search}`, headers })); }
    catch {
      this.pendingWs.get(id)?.resolveOpen(false);
      this.pendingWs.delete(id);
      server.close(1011, 'upstream websocket unavailable');
      return new Response('upstream websocket unavailable', { status: 502 });
    }
    if (!await openPromise) {
      this.pendingWs.delete(id);
      server.close(1011, 'upstream websocket unavailable');
      return new Response('upstream websocket unavailable', { status: 502 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async allocateId() {
    const id = (await this.state.storage.get('next-id') || 0) + 1;
    await this.state.storage.put('next-id', id);
    return id;
  }

  async pair(request, url) {
    if (!this.env.RELAY_SECRET || encoder.encode(this.env.RELAY_SECRET).byteLength < 32) return json({ ok: false, error: 'relay secret must contain at least 32 bytes' }, 503);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.code !== 'string' || !body.code) return json({ ok: false, error: '缺少配对码' }, 400);
    const pathId = url.pathname.match(/^\/r\/([^/]+)\/pair$/)?.[1];
    const wantedId = pathId || body.instanceId || '';
    const ip = request.headers.get('cf-connecting-ip') || '';
    const lockId = wantedId || '*';
    const lockKey = await sha256Hex(`${lockId}|${ip}`);
    const locks = await this.state.storage.get('pair-locks') || {};
    const lock = locks[lockKey];
    if (lock?.lockedUntil > Date.now()) return json({ ok: false, error: '尝试过于频繁，请稍后再试' }, 429);
    const hosts = this.state.getWebSockets('host').filter((socket) => {
      const a = socket.deserializeAttachment() || {};
      return a.registered && (!wantedId || a.instanceId === wantedId) && safeEqual(a.pairingCode, body.code);
    });
    if (hosts.length === 0) {
      const now = Date.now();
      const fails = (lock?.fails || 0) + 1;
      locks[lockKey] = { fails: fails >= 5 ? 0 : fails, lockedUntil: fails >= 5 ? now + 60_000 : 0, lastAt: now };
      const entries = Object.entries(locks);
      if (entries.length > 1024) {
        let remaining = entries.length;
        for (const [key, value] of entries) {
          if (remaining <= 512) break;
          if (value.lockedUntil <= now && now - value.lastAt > 60_000) { delete locks[key]; remaining -= 1; }
        }
      }
      await this.state.storage.put('pair-locks', locks);
      return json({ ok: false, error: '没有找到使用这个配对码的设备，核对一下中转地址' }, 404);
    }
    if (hosts.length > 1) return json({ ok: false, error: '有多台设备用着同一个配对码，请改用二维码配对' }, 409);
    delete locks[lockKey];
    await this.state.storage.put('pair-locks', locks);
    const host = hosts[0];
    if ([...this.pendingPairs.values()].filter((pending) => pending.host === host).length >= 32) return json({ ok: false, error: '该实例待处理配对请求过多，请稍后再试' }, 429);
    const requestId = crypto.randomUUID();
    const device = { ...(body.device && typeof body.device === 'object' ? body.device : {}), ip: request.headers.get('cf-connecting-ip') || '' };
    const responsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPairs.delete(requestId);
        resolve(json({ ok: false, error: '桌面端未响应授权请求，请重试' }, 408));
      }, 90_000);
      this.pendingPairs.set(requestId, { resolve, timer, host, device });
    });
    host.send(encodeFrame(0x12, 0, { requestId, device }));
    return responsePromise;
  }

  async onPairConfirm(socket, frame) {
    const msg = parseJson(frame.payload);
    const pending = this.pendingPairs.get(msg.requestId);
    if (!pending || pending.host !== socket) return;
    clearTimeout(pending.timer);
    this.pendingPairs.delete(msg.requestId);
    if (!msg.approved || typeof msg.token !== 'string' || !msg.token) {
      pending.resolve(json({ ok: false, error: '桌面端已拒绝此连接请求' }, 403));
      return;
    }
    if (!this.env.RELAY_SECRET || encoder.encode(this.env.RELAY_SECRET).byteLength < 32) {
      pending.resolve(json({ ok: false, error: 'relay secret must contain at least 32 bytes' }, 503));
      return;
    }
    try {
      const instanceId = (pending.host.deserializeAttachment() || {}).instanceId;
      const deviceId = String(pending.device.deviceId || pending.device.id || crypto.randomUUID()).slice(0, 128);
      const credential = `dshc_${randomBase64Url(32)}`;
      const record = { instanceId, deviceId, hash: await sha256Hex(credential), hostToken: msg.token, createdAt: Date.now(), expiresAt: Date.now() + 365 * 24 * 3600 * 1000 };
      await this.state.storage.put(`credential:${record.hash}`, record);
      const cookie = await this.signCookie(instanceId, deviceId);
      pending.resolve(json({ ok: true, instanceId, token: msg.token, cookie: `dsh_pair=${cookie}`, deviceId, deviceCredential: credential, ...(msg.hostPlatform ? { hostPlatform: msg.hostPlatform } : {}) }, 200, { 'set-cookie': `dsh_pair=${cookie}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000` }));
    } catch {
      pending.resolve(json({ ok: false, error: '配对授权未能完成，请重试' }, 503));
    }
  }

  async signCookie(instanceId, deviceId) {
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const payload = `${instanceId}.${base64Url(encoder.encode(deviceId))}.${exp}`;
    return `${payload}.${await hmacBase64Url(this.env.RELAY_SECRET, payload)}`;
  }

  async connectionInfo(request) {
    const auth = await this.authenticate(request);
    if (!auth) return json({ ok: false, error: 'mobile authorization required' }, 401);
    const host = this.hostFor(auth.instanceId);
    if (!host) return json({ ok: false, error: 'instance offline' }, 404);
    const a = host.deserializeAttachment() || {};
    return json({ ok: true, instanceId: a.instanceId, name: a.name, lanUrls: [], lanCandidates: [], lastSeen: Date.now() });
  }

  async revokeCredential(request) {
    const instanceId = request.headers.get('x-dsh-instance') || '';
    const credential = request.headers.get('x-dsh-device-credential') || '';
    if (!INSTANCE_ID.test(instanceId) || !credential) return json({ ok: false, error: 'invalid device credential' }, 401);
    const hash = await sha256Hex(credential);
    const record = await this.state.storage.get(`credential:${hash}`);
    if (!record || record.instanceId !== instanceId || record.revokedAt || record.expiresAt <= Date.now()) return json({ ok: false, error: 'invalid device credential' }, 401);
    let revoked = 0;
    const records = await this.state.storage.list({ prefix: 'credential:' });
    for (const [key, item] of records) {
      if (item.instanceId === instanceId && item.deviceId === record.deviceId && !item.revokedAt) {
        item.revokedAt = Date.now();
        await this.state.storage.put(key, item);
        revoked += 1;
      }
    }
    return json({ ok: true, revoked }, 200, { 'set-cookie': 'dsh_pair=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0' });
  }

  async authenticate(request) {
    const instanceId = request.headers.get('x-dsh-instance') || '';
    const authorization = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get('authorization') || '');
    if (!INSTANCE_ID.test(instanceId) || !authorization || !this.hostFor(instanceId)) return null;
    const credential = request.headers.get('x-dsh-device-credential') || '';
    if (!credential) return { instanceId, token: authorization[1] };
    const record = await this.state.storage.get(`credential:${await sha256Hex(credential)}`);
    if (!record || record.instanceId !== instanceId || record.expiresAt <= Date.now() || record.revokedAt) return null;
    if (record.hostToken !== authorization[1] && credential !== authorization[1]) return null;
    return { instanceId, token: authorization[1], record };
  }

  async proxyMobile(request, url) {
    const auth = await this.authenticate(request);
    if (!auth) return json({ ok: false, error: 'mobile authorization required' }, 401);
    return this.forwardHttp(request, url, auth.instanceId);
  }

  async forwardHttp(request, url, instanceId) {
    const host = this.hostFor(instanceId);
    if (!host) return new Response('upstream unavailable: instance offline', { status: 502 });
    const active = [...this.pendingHttp.values()].filter((item) => (item.host.deserializeAttachment() || {}).instanceId === instanceId).length;
    if (active >= 128) return new Response('relay resource limit exceeded', { status: 503 });
    const id = await this.allocateId();
    const headers = {};
    for (const [name, value] of request.headers) if (REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    this.state.waitUntil(done);
    const pending = { head: null, resolveHead: null, controller: null, queued: [], queuedBytes: 0, paused: false, ended: false, sse: (request.headers.get('accept') || '').toLowerCase().includes('text/event-stream'), idleTimer: null, host, finish };
    const headPromise = new Promise((resolve) => { pending.resolveHead = resolve; });
    this.pendingHttp.set(id, pending);
    try { host.send(encodeFrame(0x04, id, { method: request.method, path: `${url.pathname}${url.search}`, headers })); }
    catch {
      this.pendingHttp.delete(id);
      pending.finish();
      return new Response('upstream unavailable', { status: 502 });
    }
    try {
      if (request.body) {
        const reader = request.body.getReader();
        let bodyBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bodyBytes += value.byteLength;
          if (bodyBytes > 50 * 1024 * 1024) {
            await reader.cancel();
            this.pendingHttp.delete(id);
            pending.finish();
            host.send(encodeFrame(0x14, id, new Uint8Array()));
            return new Response('request body too large', { status: 413 });
          }
          for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) host.send(encodeFrame(0x05, id, value.slice(offset, Math.min(offset + 1024 * 1024, value.byteLength))));
        }
      }
      host.send(encodeFrame(0x05, id, new Uint8Array()));
      let headerTimer;
      const timeoutPromise = new Promise((resolve) => { headerTimer = setTimeout(() => resolve(null), 30_000); });
      const head = await Promise.race([headPromise, timeoutPromise]);
      clearTimeout(headerTimer);
      if (!head) {
        this.pendingHttp.delete(id);
        pending.finish();
        host.send(encodeFrame(0x14, id, new Uint8Array()));
        return new Response('upstream timeout', { status: 504 });
      }
      if (head.error) return new Response(`upstream error: ${head.error}`, { status: 502 });
      if (request.method === 'HEAD' || [204, 205, 304].includes(head.status)) {
        this.pendingHttp.delete(id);
        if (pending.idleTimer) clearTimeout(pending.idleTimer);
        pending.finish();
        try { host.send(encodeFrame(0x14, id, new Uint8Array())); } catch {}
        return new Response(null, { status: head.status || 502, headers: filterHeaders(head.headers, RESPONSE_HEADERS) });
      }
      const stream = new ReadableStream({
        start: (controller) => {
          pending.controller = controller;
          for (const chunk of pending.queued) controller.enqueue(chunk);
          pending.queued = [];
          pending.queuedBytes = 0;
          if (controller.desiredSize <= 0) this.pauseHttpResponse(pending, id);
          if (pending.ended) controller.close();
        },
        pull: () => {
          if (pending.paused) {
            pending.paused = false;
            try { pending.host.send(encodeFrame(0x16, id, new Uint8Array())); } catch {}
          }
        },
        cancel: () => {
          this.pendingHttp.delete(id);
          if (pending.idleTimer) clearTimeout(pending.idleTimer);
          pending.finish();
          host.send(encodeFrame(0x14, id, new Uint8Array()));
        },
      });
      return new Response(stream, { status: head.status || 502, headers: filterHeaders(head.headers, RESPONSE_HEADERS) });
    } catch (error) {
      this.pendingHttp.delete(id);
      pending.finish();
      return new Response(`upstream error: ${error.message}`, { status: 502 });
    }
  }

  armSseIdle(pending, id) {
    if (!pending.sse || pending.ended) return;
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      if (this.pendingHttp.get(id) !== pending) return;
      this.pendingHttp.delete(id);
      pending.idleTimer = null;
      pending.ended = true;
      try { pending.host.send(encodeFrame(0x14, id, new Uint8Array())); } catch {}
      if (pending.controller) pending.controller.close();
      pending.finish();
    }, 30_000);
  }

  pauseHttpResponse(pending, id) {
    if (pending.paused || pending.ended) return;
    pending.paused = true;
    try { pending.host.send(encodeFrame(0x15, id, new Uint8Array())); } catch {}
  }

  onHttpFrame(pending, frame) {
    if (frame.type === 0x06 && !pending.head) {
      pending.head = parseJson(frame.payload);
      this.armSseIdle(pending, frame.id);
      pending.resolveHead(pending.head);
    } else if (frame.type === 0x07) {
      this.armSseIdle(pending, frame.id);
      if (pending.controller) {
        pending.controller.enqueue(frame.payload);
        if (pending.controller.desiredSize <= 0) this.pauseHttpResponse(pending, frame.id);
      } else {
        pending.queued.push(frame.payload);
        pending.queuedBytes += frame.payload.byteLength;
        if (pending.queuedBytes >= 1024 * 1024) this.pauseHttpResponse(pending, frame.id);
      }
    } else if (frame.type === 0x08) {
      if (pending.idleTimer) clearTimeout(pending.idleTimer);
      pending.ended = true;
      if (pending.controller) pending.controller.close();
      pending.finish();
      this.pendingHttp.delete(frame.id);
    } else if (frame.type === 0x09) {
      if (pending.idleTimer) clearTimeout(pending.idleTimer);
      const error = parseJson(frame.payload);
      const message = `upstream error: ${error.message || ''}`;
      if (!pending.head) pending.resolveHead({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, error: error.message || '' });
      else {
        const bytes = encoder.encode(message);
        if (pending.controller) pending.controller.enqueue(bytes);
        else pending.queued.push(bytes);
      }
      pending.ended = true;
      if (pending.controller) pending.controller.close();
      pending.finish();
      this.pendingHttp.delete(frame.id);
    }
  }
}

export class FrameDecoder {
  constructor(onFrame, maxFrameBytes = 8 * 1024 * 1024) {
    this.onFrame = onFrame;
    this.maxFrameBytes = maxFrameBytes;
    this.pending = new Uint8Array();
  }
  push(input) {
    const chunk = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (chunk.byteLength + this.pending.byteLength > this.maxFrameBytes + 9) throw new Error('frame too large');
    const joined = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    joined.set(this.pending);
    joined.set(chunk, this.pending.byteLength);
    let offset = 0;
    const view = new DataView(joined.buffer);
    while (joined.byteLength - offset >= 9) {
      const length = view.getUint32(offset + 5);
      if (length > this.maxFrameBytes) throw new Error('frame too large');
      if (joined.byteLength - offset < 9 + length) break;
      this.onFrame({ type: view.getUint8(offset), id: view.getUint32(offset + 1), payload: joined.slice(offset + 9, offset + 9 + length) });
      offset += 9 + length;
    }
    this.pending = joined.slice(offset);
  }
}

export function encodeFrame(type, id, payload) {
  const bytes = payload instanceof Uint8Array ? payload : payload == null ? new Uint8Array() : encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const frame = new Uint8Array(9 + bytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id >>> 0);
  view.setUint32(5, bytes.byteLength);
  frame.set(bytes, 9);
  return frame;
}

function validCloseCode(code) { return Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code); }
function decodeClosePayload(bytes) {
  const raw = bytes.byteLength >= 2 ? (bytes[0] << 8) | bytes[1] : 1000;
  const code = validCloseCode(raw) ? raw : 1000;
  const reason = bytes.byteLength > 2 ? new TextDecoder().decode(bytes.slice(2)) : '';
  return [code, reason];
}
function encodeClosePayload(code, reason) {
  const chunks = [];
  let size = 0;
  for (const char of String(reason || '')) {
    const bytes = encoder.encode(char);
    if (size + bytes.byteLength > 123) break;
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  const frame = new Uint8Array(2 + size);
  const safeCode = validCloseCode(code) ? code : 1000;
  frame[0] = (safeCode >> 8) & 255;
  frame[1] = safeCode & 255;
  let offset = 2;
  for (const bytes of chunks) { frame.set(bytes, offset); offset += bytes.byteLength; }
  return frame;
}
function safeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (a.byteLength !== b.byteLength) return false;
  let mismatch = 0;
  for (let i = 0; i < a.byteLength; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
function parseJson(bytes) { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; } }
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } }); }
function filterHeaders(source = {}, allowed) { const result = new Headers(); for (const [key, value] of Object.entries(source)) if (allowed.has(key.toLowerCase())) result.set(key, String(value)); return result; }
function base64Url(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function randomBase64Url(length) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return base64Url(bytes); }
async function sha256Hex(value) { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))); return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
async function hmacBase64Url(secret, value) { const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))); }
