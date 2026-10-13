'use strict';

/**
 * 隧道 id 计数器回收守卫测试。
 *
 * 背景：`tunnelIdCounters` 按 instanceId 记「下一个 id」，只在 allocTunnelId 里写、没有任何
 * 删除路径 —— 每个曾经注册过的实例都会在模块级 Map 里留下一个永久条目（中转是长跑进程，
 * 反复配对/重连的部署会持续增长）。
 *
 * 关键分寸：**只在实例真正注销时回收**（隧道 close、服务 stop）。被顶替（同一 instanceId 换了
 * 一条新隧道）时旧连接可能还有在途帧，id 必须继续单调，否则新条目会和旧隧道的帧撞 id。
 *
 * 运行：node test/tunnel-id-release.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { allocTunnelId, releaseTunnelIds } = require('../lib/proxy-http.js');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('实例注销后计数器回收，同 id 实例重新注册从 1 开始', () => {
  const inst = { instanceId: 'id-release-1' };
  assert.equal(allocTunnelId(inst), 1);
  assert.equal(allocTunnelId(inst), 2);

  releaseTunnelIds('id-release-1');
  assert.equal(allocTunnelId(inst), 1, '实例已注销，id 无需跨生命周期单调（旧隧道不会再来帧）');
});

test('不注销则持续单调（顶替路径靠这个保证在途帧不撞 id）', () => {
  const inst = { instanceId: 'id-release-2' };
  assert.equal(allocTunnelId(inst), 1);
  const replacement = { instanceId: 'id-release-2' }; // 顶替后的新实例对象，同一个 instanceId
  assert.equal(allocTunnelId(replacement), 2);
  assert.equal(allocTunnelId(inst), 3);
  releaseTunnelIds('id-release-2');
});

test('回收只影响目标实例', () => {
  const a = { instanceId: 'id-release-a' };
  const b = { instanceId: 'id-release-b' };
  allocTunnelId(a);
  allocTunnelId(b);
  allocTunnelId(b);
  releaseTunnelIds('id-release-a');
  assert.equal(allocTunnelId(a), 1);
  assert.equal(allocTunnelId(b), 3, '别的实例的计数器不能被连带清掉');
  releaseTunnelIds('id-release-a');
  releaseTunnelIds('id-release-b');
});

test('对未知/空 instanceId 安全（close 路径可能在没分配过 id 时就跑到）', () => {
  assert.doesNotThrow(() => releaseTunnelIds(undefined));
  assert.doesNotThrow(() => releaseTunnelIds(null));
  assert.doesNotThrow(() => releaseTunnelIds(''));
  assert.doesNotThrow(() => releaseTunnelIds('never-seen'));
});

test('源码契约：注销与 stop 各释放一次，顶替路径不得释放', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  const calls = src.match(/releaseTunnelIds\(/g) || [];
  assert.equal(calls.length, 2, `server.js 只应在「注销」与「stop」两处释放，实际 ${calls.length} 处`);
  assert.match(
    src,
    /instances\.delete\(inst\.instanceId\);\s*\n\s*releaseTunnelIds\(inst\.instanceId\);/,
    '隧道 close 的注销路径必须紧跟释放',
  );
  assert.match(
    src,
    /instances\.clear\(\);/,
    'stop() 仍要清实例表',
  );
  const stopBlock = src.slice(src.indexOf('function stop()'));
  assert.match(stopBlock, /releaseTunnelIds\(inst\.instanceId\);/s, 'stop() 必须释放所有实例的计数器');
  assert.ok(
    stopBlock.indexOf('releaseTunnelIds(inst.instanceId)') < stopBlock.indexOf('instances.clear()'),
    'stop() 要在清空实例表之前释放',
  );
  // 顶替分支（prev.tunnel.close(1001, 'replaced')）之后不得释放：同一 instanceId 还活着。
  const replaceBlock = src.match(/if \(prev && prev\.tunnel !== ws\)[\s\S]*?\n\s*\}/);
  assert.ok(replaceBlock, '顶替分支应当仍然存在');
  assert.doesNotMatch(replaceBlock[0], /releaseTunnelIds/, '顶替路径不能释放计数器（id 必须继续单调）');
});
