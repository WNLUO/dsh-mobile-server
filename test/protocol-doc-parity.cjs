'use strict';

/**
 * 协议文档一致性守卫：`PROTOCOL.md` 的帧表必须与 `lib/protocol.js` 的 `T` 表一一对应。
 *
 * 为什么需要它：`T` 表是权威事实源，但此前没有任何守卫盯着文档。结果 0x12 pairRequest、
 * 0x13 pairConfirm、0x17 sync、0x18 revokeAll、0x19 revokeAllAck 五个帧在代码里跑了很久，
 * 文档表里一行都没有——照文档实现的一端会静默丢帧（收到帧没有 case 就直接 return，不报错，
 * 表现为「发了没反应」）。这里把「加帧必须同时改文档」钉死。
 *
 * 只钉 编号 ↔ 名称 的双向映射，不校验 payload 字段（那是逐帧语义，机器判不了）。
 * 插件侧的副本表由 dsh-mobile-plugin/test/protocol-parity.test.cjs 逐字节比对。
 *
 * 运行：node test/protocol-doc-parity.cjs
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

function parseCodeTable() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'protocol.js'), 'utf8');
  const block = src.match(/const T = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'lib/protocol.js 里找不到 `const T = {` … `};` 区块');
  const map = new Map();
  for (const m of block[1].matchAll(/^\s*(\w+):\s*(0x[0-9a-fA-F]+)\s*,/gm)) {
    map.set(Number(m[2]), m[1]);
  }
  assert.ok(map.size > 0, 'T 表解析为空——表结构变了？');
  return map;
}

function parseDocTable() {
  const src = fs.readFileSync(path.join(ROOT, 'PROTOCOL.md'), 'utf8');
  const map = new Map();
  for (const m of src.matchAll(/^\|\s*(0x[0-9a-fA-F]+)\s*\|\s*([A-Za-z0-9_]+)\s*\|/gm)) {
    const code = Number(m[1]);
    assert.ok(!map.has(code), `PROTOCOL.md 帧表里 ${hex(code)} 出现了两次`);
    map.set(code, m[2]);
  }
  assert.ok(map.size > 0, 'PROTOCOL.md 帧表解析为空——表头或格式变了？');
  return map;
}

const code = parseCodeTable();
const doc = parseDocTable();
const asc = (a, b) => a - b;

const missing = [...code.keys()].filter((c) => !doc.has(c)).sort(asc);
const extra = [...doc.keys()].filter((c) => !code.has(c)).sort(asc);
const renamed = [...code.keys()].filter((c) => doc.has(c) && doc.get(c) !== code.get(c)).sort(asc);

assert.deepStrictEqual(missing, [], `PROTOCOL.md 帧表缺这些帧：${missing.map(hex).join(', ')}`);
assert.deepStrictEqual(extra, [], `PROTOCOL.md 帧表有代码里不存在的帧：${extra.map(hex).join(', ')}`);
assert.deepStrictEqual(
  renamed,
  [],
  `帧名称不一致：${renamed.map((c) => `${hex(c)} protocol.js=${code.get(c)} / PROTOCOL.md=${doc.get(c)}`).join('；')}`,
);

console.log(`protocol-doc-parity: ${code.size} 个帧与 PROTOCOL.md 一一对应 ✓`);
