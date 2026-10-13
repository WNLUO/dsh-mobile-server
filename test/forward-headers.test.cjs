'use strict';

/**
 * 中转往桌面转发请求头时的白名单边界（`pickForwardHeaders`）。
 *
 * 锁两件事：
 *  1) 设备凭据必须过中转。桌面端拿 `X-Dsh-Device-Credential` 判「这台设备还活着吗」，
 *     凭证吊销后立即拒；白名单若把它漏掉，吊销就只在局域网直连那条路上生效，公网
 *     配对要等一年有效的 HMAC token 自然到期——这正是「吊销形同虚设」的成因。
 *  2) 白名单不能变成「什么都转发」：Cookie 之类的浏览器状态没有理由过中转。
 *
 * 运行：node test/forward-headers.test.cjs
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { pickForwardHeaders } = require('../lib/proxy-http.js');
const { REQUEST_HEADERS } = require('../lib/config.js');

test('设备凭据会被转发到桌面', () => {
  const out = pickForwardHeaders({ 'x-dsh-device-credential': 'dshc_abc', 'x-dsh-instance': 'i1' });
  assert.equal(out['x-dsh-device-credential'], 'dshc_abc');
  assert.ok(REQUEST_HEADERS.has('x-dsh-device-credential'), 'config 里也必须登记，否则这条断言只是自说自话');
});

test('浏览器状态与白名单外的头不会被转发', () => {
  const out = pickForwardHeaders({
    cookie: 'dsh_pair=abc; dsh_lan=def',
    'x-dsh-instance': 'i1',
    'x-forwarded-for': '1.2.3.4',
    'x-custom': 'nope',
  });
  assert.equal(out.cookie, undefined, 'Cookie 不该过中转');
  assert.deepEqual(out, {});
});

test('逐跳头即使被登记白名单也不转发', () => {
  const out = pickForwardHeaders({
    authorization: 'Bearer token',
    connection: 'keep-alive',
    upgrade: 'websocket',
    'transfer-encoding': 'chunked',
  });
  assert.equal(out.authorization, 'Bearer token');
  assert.equal(out.connection, undefined);
  assert.equal(out.upgrade, undefined);
  assert.equal(out['transfer-encoding'], undefined);
});

test('头名大小写不敏感', () => {
  const out = pickForwardHeaders({ 'X-Dsh-Device-Credential': 'dshc_abc' });
  assert.equal(out['x-dsh-device-credential'], 'dshc_abc');
});
