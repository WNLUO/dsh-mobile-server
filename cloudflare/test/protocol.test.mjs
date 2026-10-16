/** Unit tests for the isolated Worker relay prototype. */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { FrameDecoder, RelayInstance, encodeFrame } from '../src/index.mjs';

test('serves the read-only relay page, health probe, and rejects unknown routes', async () => {
  const page = await worker.fetch(new Request('https://relay.example/'), {});
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /DSH · Cloudflare Relay/);
  assert.match(html, /fetch\('\/status'/);
  assert.doesNotMatch(html, /RELAY_SECRET|TUNNEL_REGISTER_SECRET/);
  const health = await worker.fetch(new Request('https://relay.example/healthz'), {});
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  const missing = await worker.fetch(new Request('https://relay.example/unknown'), {
    RELAY: { idFromName: () => 'relay', get: () => ({ fetch: async () => new Response('not found', { status: 404 }) }) },
  });
  assert.equal(missing.status, 404);
});

test('reports only whether a registered desktop tunnel is connected', async () => {
  const host = { deserializeAttachment: () => ({ instanceId: 'private1', name: 'Private host', registered: true }), readyState: 1 };
  const relay = new RelayInstance({ getWebSockets: () => [host] }, {});
  const response = await relay.fetch(new Request('https://relay.example/status'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { ok: true, hostConnected: true });
  assert.equal(JSON.stringify(body).includes('private1'), false);
  assert.equal(JSON.stringify(body).includes('Private host'), false);
});

test('encodes protocol-v2 header and UTF-8 JSON payload', () => {
  const frame = encodeFrame(0x01, 0x01020304, { name: '桌面' });
  const view = new DataView(frame.buffer);
  assert.equal(view.getUint8(0), 1);
  assert.equal(view.getUint32(1), 0x01020304);
  assert.equal(view.getUint32(5), frame.byteLength - 9);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.slice(9))), { name: '桌面' });
});

test('decodes coalesced frames and partial frame chunks', () => {
  const frames = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame));
  const first = encodeFrame(0x10, 0, new Uint8Array());
  const second = encodeFrame(0x07, 7, new Uint8Array([1, 2, 3]));
  decoder.push(first.slice(0, 4));
  decoder.push(new Uint8Array([...first.slice(4), ...second]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(({ type, id }) => [type, id]), [[0x10, 0], [0x07, 7]]);
  assert.deepEqual([...frames[1].payload], [1, 2, 3]);
});

test('acknowledges registration and replies to application heartbeat', async () => {
  const tags = new Map();
  const attachments = new Map();
  const sent = [];
  const socket = {
    send: (frame) => sent.push(frame),
    close: (code, reason) => sent.push({ code, reason }),
    deserializeAttachment: () => attachments.get(socket) || {},
    serializeAttachment: (attachment) => attachments.set(socket, attachment),
  };
  const state = {
    getTags: (candidate) => tags.get(candidate) || ['host'],
    getWebSockets: () => [socket],
    storage: { get: async () => null, put: async () => {} },
  };
  const relay = new RelayInstance(state, { TUNNEL_REGISTER_SECRET: 'shared' });
  await relay.onFrame(socket, { type: 0x01, payload: new TextEncoder().encode(JSON.stringify({ instanceId: 'abcdef', pairingCode: '123456', secret: 'shared' })) });
  assert.equal(new DataView(sent[0].buffer).getUint8(0), 0x02);
  await relay.onFrame(socket, { type: 0x10, payload: new Uint8Array() });
  assert.equal(new DataView(sent[1].buffer).getUint8(0), 0x11);
});

test('revokes all active credentials for the registered instance and acknowledges the frame', async () => {
  const records = new Map([
    ['credential:one', { instanceId: 'abcdef', deviceId: 'phone1', expiresAt: Date.now() + 60_000 }],
    ['credential:already-revoked', { instanceId: 'abcdef', deviceId: 'phone2', revokedAt: 1 }],
    ['credential:other-instance', { instanceId: 'ghijkl', deviceId: 'phone3' }],
  ]);
  const socket = {
    send: (frame) => sent.push(frame),
    deserializeAttachment: () => ({ instanceId: 'abcdef', registered: true }),
  };
  const sent = [];
  const state = {
    getTags: () => ['host'],
    storage: {
      list: async ({ prefix }) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
      put: async (key, value) => records.set(key, value),
    },
    waitUntil: () => {},
  };
  const relay = new RelayInstance(state, {});
  await relay.webSocketMessage(socket, encodeFrame(0x18, 0, { at: Date.now() }));
  assert.equal(new DataView(sent[0].buffer).getUint8(0), 0x19);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent[0].slice(9))), { ok: true, revoked: 1 });
  assert.ok(records.get('credential:one').revokedAt);
  assert.equal(records.get('credential:already-revoked').revokedAt, 1);
  assert.equal(records.get('credential:other-instance').revokedAt, undefined);
});

test('rate-limits repeated pairing-code failures by instance and client IP', async () => {
  const values = new Map();
  const state = { getWebSockets: () => [], storage: { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) } };
  const relay = new RelayInstance(state, { RELAY_SECRET: 'a-relay-signing-key-for-tests-with-32-bytes' });
  const makeRequest = () => new Request('https://relay.example/r/pair01/pair', { method: 'POST', body: JSON.stringify({ code: '000000' }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' } });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await relay.pair(makeRequest(), new URL('https://relay.example/r/pair01/pair'))).status, 404);
  assert.equal((await relay.pair(makeRequest(), new URL('https://relay.example/r/pair01/pair'))).status, 429);
});

test('waits for asynchronous pair credential persistence before completing the WebSocket event', async () => {
  const attachments = new Map();
  const sent = [];
  const socket = {
    send: (frame) => sent.push(frame),
    close: () => {},
    deserializeAttachment: () => attachments.get(socket) || {},
    serializeAttachment: (attachment) => attachments.set(socket, attachment),
  };
  attachments.set(socket, { instanceId: 'pair01', pairingCode: '123456', registered: true });
  const values = new Map();
  let releaseCredentialWrite;
  let notifyCredentialWrite;
  const credentialWriteStarted = new Promise((resolve) => { notifyCredentialWrite = resolve; });
  const credentialWriteGate = new Promise((resolve) => { releaseCredentialWrite = resolve; });
  const state = {
    getWebSockets: () => [socket],
    getTags: () => ['host'],
    waitUntil: () => {},
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => {
        if (key.startsWith('credential:')) { notifyCredentialWrite(); await credentialWriteGate; }
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
      list: async () => values,
    },
  };
  const relay = new RelayInstance(state, { RELAY_SECRET: 'a-relay-signing-key-for-tests-with-32-bytes' });
  const pending = relay.pair(new Request('https://relay.example/pair', { method: 'POST', body: JSON.stringify({ code: '123456', device: { deviceId: 'phone1' } }), headers: { 'content-type': 'application/json' } }), new URL('https://relay.example/pair'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  const requestId = JSON.parse(new TextDecoder().decode(sent[0].slice(9))).requestId;
  const event = relay.webSocketMessage(socket, encodeFrame(0x13, 0, { requestId, approved: true, token: 'host-token' }));
  await credentialWriteStarted;
  let eventComplete = false;
  event.then(() => { eventComplete = true; });
  await Promise.resolve();
  assert.equal(eventComplete, false);
  releaseCredentialWrite();
  await event;
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.instanceId, 'pair01');
  assert.match(body.deviceCredential, /^dshc_/);
  assert.equal(body.deviceId, 'phone1');
  assert.equal([...values.keys()].filter((key) => key.startsWith('credential:')).length, 1);
});

test('routes upstream WebSocket text and binary frames to the attached phone', async () => {
  const hostAttachment = { instanceId: 'ws0001', registered: true };
  const phoneAttachment = { kind: 'phone', instanceId: 'ws0001', id: 42 };
  const phoneFrames = [];
  const host = { deserializeAttachment: () => hostAttachment, readyState: 1 };
  const phone = { deserializeAttachment: () => phoneAttachment, send: (frame) => phoneFrames.push(frame) };
  const state = {
    getWebSockets: (tag) => tag === 'host' ? [host] : [phone],
    getTags: (socket) => socket === host ? ['host'] : ['phone'],
    storage: { get: async () => null, put: async () => {} },
  };
  const relay = new RelayInstance(state, {});
  await relay.onFrame(host, { type: 0x0d, id: 42, payload: new TextEncoder().encode('hello') });
  assert.equal(phoneFrames[0], 'hello');
  await relay.onFrame(host, { type: 0x0e, id: 42, payload: new Uint8Array([3, 4]) });
  assert.deepEqual([...new Uint8Array(phoneFrames[1])], [3, 4]);
});

test('forwards a mobile HTTP response as a stream through protocol-v2 frames', async () => {
  const sent = [];
  const socket = {
    send: (frame) => sent.push(frame),
    deserializeAttachment: () => ({ instanceId: 'http01', registered: true }),
  };
  const stored = new Map();
  const state = {
    getWebSockets: () => [socket],
    storage: { get: async (key) => stored.get(key), put: async (key, value) => stored.set(key, value) },
    waitUntil: () => {},
  };
  const relay = new RelayInstance(state, {});
  const resultPromise = relay.forwardHttp(new Request('https://relay.example/api/mobile/v1/status'), new URL('https://relay.example/api/mobile/v1/status'), 'http01');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const headerFrame = encodeFrame(0x06, 1, { status: 201, headers: { 'content-type': 'text/plain' } });
  await relay.onFrame(socket, { type: 0x06, id: 1, payload: headerFrame.slice(9) });
  const result = await resultPromise;
  const reader = result.body.getReader();
  await relay.onFrame(socket, { type: 0x07, id: 1, payload: new TextEncoder().encode('stream body') });
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'stream body');
  assert.equal(result.status, 201);
  await relay.onFrame(socket, { type: 0x08, id: 1, payload: new Uint8Array() });
  assert.equal((await reader.read()).done, true);
  assert.equal(new DataView(sent[0].buffer).getUint8(0), 0x04);
  assert.ok(sent.some((frame) => frame instanceof Uint8Array && new DataView(frame.buffer, frame.byteOffset).getUint8(0) === 0x15));
  assert.ok(sent.some((frame) => frame instanceof Uint8Array && new DataView(frame.buffer, frame.byteOffset).getUint8(0) === 0x16));
});

test('rejects oversized frames', () => {
  const decoder = new FrameDecoder(() => {}, 3);
  assert.throws(() => decoder.push(encodeFrame(0x07, 1, new Uint8Array(4))), /frame too large/);
});
