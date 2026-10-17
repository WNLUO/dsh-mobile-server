'use strict';

/**
 * 转发头规则：自建版是纯转发，请求头与响应头除了**逐跳头**与 `host` 之外一律原样带过去。
 *
 * 以前这里是一份白名单，漏一个头就是**静默丢**（宿主看到的行为与「手机没发这个头」完全
 * 一样），每加一个自定义头都要记得同步。纯转发的定位下这份白名单没有理由存在。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickForwardHeaders, sanitizeRespHeaders } = require('../lib/proxy-http.js');

test('端到端头原样带过去（含自定义头与 Authorization）', () => {
  const out = pickForwardHeaders({
    accept: 'application/json',
    authorization: 'Bearer abc',
    'content-type': 'application/json',
    cookie: 'a=1',
    'x-dsh-device-credential': 'dshc_xyz',
    'x-anything-custom': 'keep-me',
  });
  assert.equal(out.authorization, 'Bearer abc');
  assert.equal(out.cookie, 'a=1');
  assert.equal(out['x-dsh-device-credential'], 'dshc_xyz');
  assert.equal(out['x-anything-custom'], 'keep-me', '自定义头不得被白名单吞掉');
  assert.equal(out['content-type'], 'application/json');
});

test('逐跳头与 host 必须丢掉', () => {
  const out = pickForwardHeaders({
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    te: 'trailers',
    trailer: 'x',
    'proxy-authorization': 'Basic x',
    'content-length': '12',
    host: 'relay.example.com',
    'x-ok': '1',
  });
  for (const dropped of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'content-length', 'host']) {
    assert.equal(out[dropped], undefined, `${dropped} 不得转发`);
  }
  assert.equal(out['x-ok'], '1');
});

test('大小写混杂的逐跳头同样被丢掉', () => {
  const out = pickForwardHeaders({ Connection: 'close', Host: 'relay', 'X-Keep': '1' });
  assert.equal(out.connection, undefined);
  assert.equal(out.host, undefined);
  assert.equal(out['x-keep'], '1');
});

test('响应头走同一套规则', () => {
  const out = sanitizeRespHeaders({
    'content-type': 'text/plain',
    'content-length': '3',
    connection: 'keep-alive',
    'set-cookie': 'a=1',
    'x-custom': '1',
  });
  assert.equal(out['content-type'], 'text/plain');
  assert.equal(out['x-custom'], '1');
  assert.equal(out['content-length'], undefined, '正文由中转重新分块，长度头必须丢掉');
  assert.equal(out.connection, undefined);
});
