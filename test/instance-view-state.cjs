'use strict';

/**
 * 回归：写实例状态必须落到「实例本体」，不能落在请求视图上。
 *
 * 现场：pair.js 的 pairedInstance()/mobileInstance()/authenticatedMobileInstance()
 * 都返回 `{ ...inst, __deviceCredential: record }` —— 一份浅拷贝。它按值复制
 * nextId / mirror / mirrorAt / mirrorSlotAt / mirrorDiskMissAt 这类标量或引用，
 * 于是**视图上的赋值会落在临时对象上被静默丢弃**。已经踩过两次：
 *   1. 隧道帧 id 恒为 1（见 test/tunnel-id-allocation.cjs）：并发请求在 inst.pending
 *      里互相顶掉条目，流式响应只剩一帧 preamble；
 *   2. server.js 把 `mobileInstance(req) || pairedInstance(req)` 的**视图**直接交给
 *      proxyCached()，于是：
 *      · `installMirror(inst, diskMirror.mirror, …)` 的重赋值丢了 —— 磁盘兜底镜像
 *        永远装不进内存（隧道断开且内存冷时手机拿不到镜像）；
 *      · `inst.mirrorDiskMissAt = Date.now()` 丢了 —— 10s 负缓存永不生效，
 *        每个请求都同步读盘 + JSON.parse（上限 4MB）。
 *
 * 修法：视图带一个不可枚举的 __canonical 回指，server.js 解析后立刻用
 * canonicalInstance() 取回本体再交给 proxyCached()/proxyRequest()，凭据改经
 * proxyOptions.credential 传递（本体上没有 __deviceCredential 字段，不能再从
 * inst 上读它，否则镜像缓存会整条失效）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 凭据库在模块加载时按环境变量定路径，必须先设好再 require。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instance-view-'));
process.env.DEVICE_CREDENTIALS_FILE = path.join(tmp, 'relay-device-credentials.json');

const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');
const { instances } = require('../lib/registry.js');
const { mobileInstance, requestView, canonicalInstance } = require('../lib/pair.js');
const { installMirror, mirrorSlotAt, applyMirrorRefresh } = require('../lib/mirror-state.js');

const INSTANCE = 'viewstate01';

/** 造一个注册好的实例本体；每次调用都换新对象，避免用例之间互相污染。 */
function freshInstance() {
  const inst = { instanceId: INSTANCE, pending: new Map(), mirror: undefined, mirrorAt: 0 };
  instances.set(INSTANCE, inst);
  return inst;
}

/** 去掉注释，避免源码契约断言误匹配说明文字里的示例代码。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('requestView 只带请求级凭据，__canonical 指回本体且不可枚举', () => {
  const inst = freshInstance();
  const view = requestView(inst, { hostToken: 'tok-view' });
  assert.strictEqual(view.__deviceCredential.hostToken, 'tok-view');
  assert.strictEqual(canonicalInstance(view), inst, 'canonicalInstance 必须还原出本体');
  assert.strictEqual(canonicalInstance(inst), inst, '本体上取本体应是恒等');
  assert.strictEqual(canonicalInstance(null), null);
  assert.strictEqual(canonicalInstance(undefined), undefined);
  assert.ok(
    !Object.keys(view).includes('__canonical'),
    '__canonical 不能可枚举：展开/序列化视图时不该把回指带出去',
  );
});

test('磁盘兜底镜像必须装进实例本体，装在视图上等于丢弃', () => {
  const inst = freshInstance();
  const view = requestView(inst, { hostToken: 'tok-view' });
  const mirror = { sessions: { ok: true, items: [] } };

  installMirror(view, mirror, 1_700_000_000_000);
  assert.strictEqual(inst.mirror, undefined, '写视图就是旧缺陷：本体仍没有镜像');
  assert.strictEqual(inst.mirrorAt, 0);
  assert.strictEqual(inst.mirrorSlotAt, undefined);

  const at = installMirror(canonicalInstance(view), mirror, 1_700_000_000_000);
  assert.strictEqual(inst.mirror, mirror, '写本体后镜像才真正可读');
  assert.strictEqual(inst.mirrorAt, 1_700_000_000_000);
  assert.strictEqual(at, 1_700_000_000_000);
  assert.strictEqual(Number(inst.mirrorSlotAt.sessions), 1_700_000_000_000, '槽位时间戳也要落到本体');
});

test('mirrorDiskMissAt 负缓存必须落在本体', () => {
  const inst = freshInstance();
  const view = requestView(inst, { hostToken: 'tok-view' });
  view.mirrorDiskMissAt = 12_345;
  assert.strictEqual(inst.mirrorDiskMissAt, undefined, '写视图不生效');
  canonicalInstance(view).mirrorDiskMissAt = 12_345;
  assert.strictEqual(inst.mirrorDiskMissAt, 12_345, '写本体才生效（否则每请求同步读盘）');
});

test('mobileInstance() 解析出的视图能还原到 instances 里的本体', () => {
  const inst = freshInstance();
  const issued = credentials.issue(INSTANCE, { deviceId: 'dev-viewstate' }, 'host-token-1');
  const req = {
    url: '/api/mobile/v1/sessions',
    headers: { 'x-dsh-instance': INSTANCE, 'x-dsh-device-credential': issued.credential },
  };
  const view = mobileInstance(req);
  assert.ok(view, '有效设备凭据应解析出实例');
  assert.strictEqual(view.__deviceCredential.hostToken, 'host-token-1', '凭据挂在视图上');
  assert.strictEqual(canonicalInstance(view), inst, '必须还原到注册表里的那个本体');
  assert.strictEqual(inst.__deviceCredential, undefined, '本体上不该有请求级凭据');
});

test('后台镜像刷新把新鲜 body 写回本体槽位', () => {
  const inst = freshInstance();
  const view = requestView(inst, { hostToken: 'tok-view' });
  const target = canonicalInstance(view);
  installMirror(target, { sessions: { ok: true, items: [] } }, 1_000);
  const ok = applyMirrorRefresh(target, '/api/mobile/v1/session/messages', 'sess-1', {
    ok: true,
    items: [{ seq: 1 }],
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(inst.mirror.messages['sess-1'].items.length, 1, '刷新结果要落到本体');
  assert.ok(mirrorSlotAt(inst, 'messages', 'sess-1') >= 1_000, '槽位水位要被前移');
});

test('server.js 契约：先取本体再交给 proxyCached/proxyRequest，凭据走 options', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  assert.match(
    code,
    /const view = mobileInstance\(req\) \|\| \(declaredInstanceId \? null : pairedInstance\(req\)\);/,
    '必须先拿视图，且点名了实例就不许回落到配对 cookie（cookie 是设备级全局槽位，会把离线设备的请求发给另一台在线设备）',
  );
  assert.match(
    code,
    /const declaredInstanceId = typeof req\.headers\['x-dsh-instance'\] === 'string'/,
    '实例标识要先判定「请求带没带」',
  );
  assert.match(code, /const inst = canonicalInstance\(view\);/, '必须立刻还原本体');
  assert.match(code, /const credential = view && view\.__deviceCredential;/, '凭据从视图上取');
  // 命中镜像/响应缓存的两个前提：有设备凭据（= 走的是移动端读路径），且不是
  // `?fresh=1`。fresh 是移动端从被污染的代读副本里脱身的唯一手段（真机症状：
  // 侧边栏空了只有下拉刷新能救），被缓存顶掉就等于把自救路堵死。
  assert.match(
    code,
    /const mayServeCache = Boolean\(options && options\.credential\) && !fresh;/,
    '镜像缓存既要看 options.credential，也必须给 ?fresh=1 让路',
  );
  assert.match(code, /const fresh = isFreshRequest\(req\.url\);/, '必须先识别 fresh 标记');
  assert.match(code, /return proxyCached\(inst, req, res, proxyOptions\);/, '交给 proxyCached 的必须是本体');
  assert.match(code, /return proxyRequest\(inst, req, res, proxyOptions\);/, '交给 proxyRequest 的必须是本体');
  assert.ok(!/inst\.__deviceCredential/.test(code), 'server.js 不能再从实例本体读凭据（本体上没有该字段）');
});

test('pair.js 契约：三个解析函数一律经 requestView 返回', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pair.js'), 'utf8'));
  assert.strictEqual((code.match(/return requestView\(inst, record\);/g) || []).length, 2, 'pairedInstance/authenticatedMobileInstance');
  assert.strictEqual((code.match(/return record \? requestView\(inst, record\) : null;/g) || []).length, 1, 'mobileInstance');
});
