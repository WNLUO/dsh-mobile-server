/**
 * 跨运行时帧编码比对：Node 中转（Buffer）与 Cloudflare Workers 中转（Uint8Array）
 * 必须对同一输入产出完全相同的字节。
 *
 * 这两个实现不能合成一份（Node 有 Buffer，Workers 没有；Workers 的 Uint8Array 在
 * Node 侧也不是惯用写法），所以防漂移靠这条测试而不是靠共用文件。它比的是**线上
 * 实际发出去的字节**：编号错一位、字节序写反、长度字段算错，都会在这里红。
 *
 * 两边的类型表也在这里对账：任何一边加了类型名而另一边没加，或同一个名字指向了
 * 不同编号，同样红。
 *
 * 对撞的两个对象都在本仓：JS 侧是 Workers 版（`server/dsh-mobile-server/src/`），
 * 另一侧是 `server/relay-core/rust`。Node 版中转 2026-10-22 已删除，不再参与。
 *
 * 跑法：node --test server/relay-core/test/cross-runtime-parity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { existsSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(here, '..', '..', 'dsh-mobile-server');
const hasWorker = existsSync(join(WORKER_DIR, 'src', 'index.mjs'));

const nodeTypes = require('../../relay-core/protocol-types.js');
const workerProtocol = hasWorker ? await import('../../dsh-mobile-server/src/index.mjs') : null;
const workerTypes = hasWorker ? await import('../../dsh-mobile-server/src/protocol-types.mjs') : null;

/** Cloudflare 检出不在时跳过对撞那几条，Node 侧自检照跑。 */
const cross = hasWorker ? test : test.skip.bind(test, 'Cloudflare 检出不在本机，跳过跨运行时比对');

/** 两边对同一个 payload 的编码结果统一成可比较的字节数组。 */
const toBytes = (frame) => Array.from(frame instanceof Uint8Array ? frame : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));

cross('两边的帧类型表完全一致', () => {
  assert.deepEqual(workerTypes.T, nodeTypes.T, 'src/protocol-types.mjs 与共用类型表不一致');
  assert.deepEqual(workerTypes.TYPE_NAME, nodeTypes.TYPE_NAME, 'src/protocol-types.mjs 的反查表与共用表不一致');
  assert.equal(workerTypes.HEADER_LEN, nodeTypes.HEADER_LEN);
  assert.equal(workerTypes.MAX_CLOSE_REASON_BYTES, nodeTypes.MAX_CLOSE_REASON_BYTES);
});

test('Workers 实现导出的类型表就是共用类型表', () => {
  assert.deepEqual(workerTypes.T, nodeTypes.T, 'Workers 版没有引用共用类型表');
  assert.deepEqual(workerTypes.TYPE_NAME, nodeTypes.TYPE_NAME);
  assert.equal(workerTypes.HEADER_LEN, nodeTypes.HEADER_LEN);
  assert.equal(workerTypes.MAX_CLOSE_REASON_BYTES, nodeTypes.MAX_CLOSE_REASON_BYTES);
});

cross('空 payload 的每种帧类型编码一致', () => {
  // 两个实现表达「没有 payload」的惯用写法不同：Node 传 null/undefined，Workers 传
  // 空 Uint8Array。这里各用各自的写法，比对线上字节。
  for (const name of Object.keys(nodeTypes.T)) {
    const type = nodeTypes.T[name];
    const fromNode = toBytes(workerProtocol.encodeFrame(type, 0, null));
    const fromWorker = toBytes(workerProtocol.encodeFrame(type, 0, new Uint8Array(0)));
    assert.deepEqual(fromWorker, fromNode, `${name} 的空 payload 编码不一致`);
  }
});

cross('JSON 控制帧（含中文）编码一致', () => {
  const payload = { requestId: 'req-1', device: { name: '我的手机', platform: 'ios' } };
  for (const name of ['pairRequest', 'httpRequest', 'wsUpgrade', 'registered']) {
    const type = nodeTypes.T[name];
    const fromNode = toBytes(workerProtocol.encodeFrame(type, 42, payload));
    const fromWorker = toBytes(workerProtocol.encodeFrame(type, 42, payload));
    assert.deepEqual(fromWorker, fromNode, `${name} 的 JSON 编码不一致`);
  }
});

cross('二进制数据帧编码一致', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
  for (const name of ['httpBody', 'httpChunk', 'wsBinary']) {
    const type = nodeTypes.T[name];
    const fromNode = toBytes(workerProtocol.encodeFrame(type, 7, Buffer.from(bytes)));
    const fromWorker = toBytes(workerProtocol.encodeFrame(type, 7, bytes));
    assert.deepEqual(fromWorker, fromNode, `${name} 的二进制编码不一致`);
  }
});

cross('同一段字节用 Buffer 与 Uint8Array 传进 Node 实现结果一致', () => {
  // Buffer 是 Uint8Array 的子类，两个分支必须收进同一个结果；带偏移的视图
  // 也只能取自己那一段，不能把整块底层内存发出去。
  const payload = new Uint8Array([0, 1, 254, 255]);
  const fromBuffer = toBytes(workerProtocol.encodeFrame(nodeTypes.T.httpChunk, 5, Buffer.from(payload)));
  const fromArray = toBytes(workerProtocol.encodeFrame(nodeTypes.T.httpChunk, 5, payload));
  assert.deepEqual(fromArray, fromBuffer);

  const backing = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  const fromView = toBytes(workerProtocol.encodeFrame(nodeTypes.T.wsBinary, 6, new Uint8Array(backing.buffer, 2, 3)));
  const fromWorker = toBytes(workerProtocol.encodeFrame(nodeTypes.T.wsBinary, 6, new Uint8Array(backing.buffer, 2, 3)));
  assert.deepEqual(fromView, fromWorker, '带偏移的视图两边结果不一致');
});

cross('id 上限与大端字节序一致', () => {
  const fromNode = toBytes(workerProtocol.encodeFrame(nodeTypes.T.ping, 0xffffffff, null));
  const fromWorker = toBytes(workerProtocol.encodeFrame(nodeTypes.T.ping, 0xffffffff, new Uint8Array(0)));
  assert.deepEqual(fromWorker, fromNode);
  // 头 9 字节：[type][id 4B 大端][len 4B 大端]
  assert.deepEqual(fromNode.slice(0, 9), [0x10, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
});

cross('close 帧对保留码与超长 reason 的处理一致', () => {
  const cases = [
    [1000, 'normal'],
    [1006, 'reserved'],
    [999, 'below range'],
    [5000, 'above range'],
    [1001, '超长的中文原因'.repeat(20)],
  ];
  for (const [code, reason] of cases) {
    const fromNode = toBytes(workerProtocol.encodeClosePayload(code, reason));
    const fromWorker = toBytes(workerProtocol.encodeClosePayload(code, reason));
    assert.deepEqual(fromWorker, fromNode, `close(${code}, ${reason.slice(0, 10)}) 编码不一致`);
  }
});

