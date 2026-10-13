'use strict';

/**
 * 隧道注册准入的回归测试。
 *
 * 锁定三条边界，都是「判错一次就长时间查不出问题」的那种：
 *  1) 白名单文件存在时，白名单外的 instanceId 一律拒（哪怕共享密钥为空）；
 *  2) 共享密钥与白名单同时配置时，两道都要过（不因过了密钥就跳过白名单）；
 *  3) 白名单文件不存在 = 开放模式（文件不存在不是错误）；文件存在但 JSON 不合法
 *     必须抛错启动失败 —— 静默降级成开放比直接起不来危险得多。
 *
 * 运行：node test/tunnel-registration.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadInstanceAllowlist, tunnelRegistrationDecision } = require('../lib/tunnel-registration.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-allowlist-'));
const file = (name, content) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, content);
  return target;
};

// ── 白名单加载 ──────────────────────────────────────────────────────
assert.deepEqual([...loadInstanceAllowlist(path.join(dir, 'missing.json'))], [], '缺失文件 = 不限制');
assert.deepEqual([...loadInstanceAllowlist('')], [], '未配置路径 = 不限制');
assert.deepEqual(
  [...loadInstanceAllowlist(file('a.json', JSON.stringify({ instances: ['e889ea75', 'other1'] })))],
  ['e889ea75', 'other1'],
  '{instances:[...]} 形状',
);
assert.deepEqual(
  [...loadInstanceAllowlist(file('b.json', JSON.stringify(['e889ea75'])))],
  ['e889ea75'],
  '裸数组形状',
);
assert.deepEqual(
  [...loadInstanceAllowlist(file('c.json', JSON.stringify({ instances: [{ instanceId: 'e889ea75' }] })))],
  ['e889ea75'],
  '对象元素取 instanceId',
);
for (const [name, content, why] of [
  ['bad1.json', '{not json', '语法错'],
  ['bad2.json', '{"nope": 1}', '形状错'],
  ['bad3.json', '{"instances": ["short"]}', 'instanceId 太短'],
]) {
  assert.throws(() => loadInstanceAllowlist(file(name, content)), /instance allowlist/, `${why} 必须抛错`);
}

// ── 准入判定 ────────────────────────────────────────────────────────
const allow = (o) => tunnelRegistrationDecision({ instanceId: 'e889ea75', secret: undefined, ...o });

assert.equal(allow({}).ok, true, '全空 = 开放模式');
assert.equal(allow({}).mode, 'open');

assert.equal(allow({ registerSecret: 'sekret' }).ok, false, '配了密钥而客户端没发 = 拒');
assert.equal(allow({ registerSecret: 'sekret' }).reason, 'bad register secret');
assert.equal(allow({ registerSecret: 'sekret', secret: 'sekret' }).ok, true);
assert.equal(allow({ registerSecret: 'sekret', secret: 'sekret' }).mode, 'secret');

const list = loadInstanceAllowlist(file('ok.json', JSON.stringify({ instances: ['e889ea75'] })));
assert.equal(allow({ instances: list }).ok, true, '白名单内 = 放行');
assert.equal(allow({ instances: list }).mode, 'allowlist');
assert.equal(allow({ instances: list, instanceId: 'deadbeef' }).ok, false, '白名单外 = 拒');
assert.equal(allow({ instances: list, instanceId: 'deadbeef' }).reason, 'unknown instance');

// 两道都要过：密钥对了但不在白名单，仍然拒。
assert.equal(
  allow({ registerSecret: 'sekret', secret: 'sekret', instances: list, instanceId: 'deadbeef' }).ok,
  false,
  '过密钥不等于过白名单',
);
assert.equal(
  allow({ registerSecret: 'sekret', secret: 'sekret', instances: list }).mode,
  'secret',
  '两道都过时按密钥计模式',
);

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — tunnel registration admission');