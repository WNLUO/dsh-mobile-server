'use strict';

/**
 * 回归：隧道帧 id 必须按实例单调分配，不能被「浅拷贝视图」重置。
 *
 * 现场（实时 SSE 只收到 `: connected` 然后永久静默）：
 * pair.js 的 pairedInstance()/mobileInstance()/authenticatedMobileInstance()
 * 都返回 `{ ...inst, __deviceCredential: record }` —— `pending` 这个 Map 是按引用
 * 共享的，`nextId` 却按值拷贝。旧实现直接 `inst.nextId++`，于是每个请求都拿到
 * 同一个 id：后一个请求覆盖前一个在 pending 里的条目，前一个流式响应此后再也
 * 匹配不到条目（tunnel-handler 的 `T.httpChunk` 在 `!entry` 时静默 return），帧被
 * 丢光，客户端只收到一帧 preamble。实测：`GET /session/stream` 与
 * `POST /session/send` 同时打过来时，relay 日志里后续 32 个 chunk 全部
 * `hasEntry=false`，而插件侧确认那些字节确实发出去了。
 *
 * 修法：计数器按 instanceId 存在 proxy-http.js 的模块级 Map 上，与「本次请求拿到
 * 的是哪份视图」无关。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { proxyRequest, allocTunnelId } = require('../lib/proxy-http.js');
const { handleTunnelFrame } = require('../lib/tunnel-handler.js');
const { T } = require('../lib/protocol.js');

function fakeInstance(instanceId) {
  const frames = [];
  return {
    instanceId,
    pending: new Map(),
    frames,
    tunnel: { readyState: 1, bufferedAmount: 0, send: (frame) => frames.push(frame) },
  };
}

/** pair.js 三个解析函数返回的形状：浅拷贝 + 本次请求自己的凭据。 */
function cloneView(inst, tag) {
  return { ...inst, __deviceCredential: { hostToken: `tok-${tag}` } };
}

function fakeReq(url, accept) {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'GET';
  req.headers = accept ? { accept } : {};
  req.destroy = () => {};
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.chunks = [];
  res.ended = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => { if (chunk) res.chunks.push(Buffer.from(chunk)); res.ended = true; };
  res.body = () => Buffer.concat(res.chunks).toString('utf8');
  return res;
}

const jsonPayload = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

test('浅拷贝视图不会重置 id 计数器', () => {
  const inst = fakeInstance('inst-clone');
  const idA = allocTunnelId(cloneView(inst, 'a'));
  const idB = allocTunnelId(cloneView(inst, 'b'));
  assert.notEqual(idA, idB, '同一实例的两个请求视图必须拿到不同 id');
  assert.equal(idB, idA + 1, '同一实例内 id 单调递增');
});

test('不同实例各自计数，互不影响', () => {
  const x = fakeInstance('inst-x');
  const y = fakeInstance('inst-y');
  const x1 = allocTunnelId(x);
  const x2 = allocTunnelId(x);
  const y1 = allocTunnelId(y);
  assert.equal(x2, x1 + 1);
  assert.equal(y1, 1, '另一个实例的计数从 1 开始');
});

test('并发请求各占一个条目，先结束的那个不会让另一个的帧丢失', () => {
  const inst = fakeInstance('inst-concurrent');
  const resA = fakeRes();
  const resB = fakeRes();

  // 两个并发请求各自拿到一份浅拷贝视图（正是 pair.js 的真实行为）。
  proxyRequest(cloneView(inst, 'a'), fakeReq('/api/mobile/v1/session/stream?sessionId=s1', 'text/event-stream'), resA);
  proxyRequest(cloneView(inst, 'b'), fakeReq('/api/mobile/v1/session/send', 'application/json'), resB);

  assert.equal(inst.pending.size, 2, '两个请求必须在 pending 里各占一个条目');
  const [idA, idB] = [...inst.pending.keys()];
  assert.notEqual(idA, idB);

  // A 是 SSE：先写 preamble。
  handleTunnelFrame(inst, { type: T.httpHead, id: idA, payload: jsonPayload({ status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  handleTunnelFrame(inst, { type: T.httpChunk, id: idA, payload: Buffer.from(': connected\n\n') });

  // B 完成 head + body + end。旧实现里 A、B 共用 id=1，这一步会把 A 的条目一并删掉。
  handleTunnelFrame(inst, { type: T.httpHead, id: idB, payload: jsonPayload({ status: 200, headers: { 'content-type': 'application/json' } }) });
  handleTunnelFrame(inst, { type: T.httpChunk, id: idB, payload: Buffer.from('{"ok":true}') });
  handleTunnelFrame(inst, { type: T.httpEnd, id: idB, payload: Buffer.alloc(0) });

  assert.equal(resB.body(), '{"ok":true}');
  assert.equal(resB.ended, true);
  assert.ok(inst.pending.has(idA), 'B 结束后 A 的条目必须还在');

  // A 继续产出：必须仍然送达客户端。
  handleTunnelFrame(inst, { type: T.httpChunk, id: idA, payload: Buffer.from(': keepalive\n\n') });
  assert.equal(resA.body(), ': connected\n\n: keepalive\n\n', 'A 的后续帧不能被静默丢弃');

  // 收尾，清掉 A 的空闲哨兵，避免测试进程被 30s 定时器挂住。
  handleTunnelFrame(inst, { type: T.httpEnd, id: idA, payload: Buffer.alloc(0) });
  assert.equal(resA.ended, true);
});

/** 去掉注释后再做源码契约断言：说明文字里会提到 `inst.nextId++` 这个反面例子。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('源码契约：实例上不再有 nextId，自增一律走 allocTunnelId', () => {
  const root = path.join(__dirname, '..');
  const serverSrc = stripComments(fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
  assert.equal(/nextId/.test(serverSrc), false, 'server.js 不应再在实例字面量里种 nextId');
  for (const name of ['proxy-http.js', 'bridge-ws.js']) {
    const src = stripComments(fs.readFileSync(path.join(root, 'lib', name), 'utf8'));
    assert.equal(/inst\.nextId/.test(src), false, `${name} 不得再直接读写实例上的 nextId`);
    assert.match(src, /allocTunnelId\(inst\)/, `${name} 必须用 allocTunnelId(inst) 分配 id`);
  }
});
