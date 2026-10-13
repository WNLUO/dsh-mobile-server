'use strict';

/**
 * 请求追踪落盘「关闭时刷盘」回归测试。
 *
 * request-trace 的 save() 是 1s 防抖，且 saveTimer 被 unref —— 于是进程退出时
 * 最后一秒的条目本来是丢的，与文件头写明的「重启不丢」相悖。stop() 现在会先
 * flush 再 resolve，本测试锁定这条接线（否则 flush 又变回无人调用的死导出）。
 *
 * 运行：node test/request-trace-flush.cjs
 */

process.env.PORT = String(process.env.TRACE_PORT || 18708);
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'request-trace-secret-0123456789';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

// 用临时文件隔离追踪存储，避免污染真实 plugin-ota 目录。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trace-'));
process.env.REQUEST_TRACE_FILE = path.join(tmp, 'request-trace.json');

const requestTrace = require('../lib/request-trace.js');
const { stop } = require('../server.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

async function main() {
  await test('1s 防抖窗口内条目尚未落盘', () => {
    requestTrace.record('inst-trace', { route: '/api/mobile/v1/probe', servedBy: 'live', status: 200, latencyMs: 3 });
    assert.strictEqual(fs.existsSync(requestTrace.FILE), false, '防抖窗口内不应已写盘');
  });

  await test('stop() 会把待写条目刷盘', async () => {
    await stop();
    assert.ok(fs.existsSync(requestTrace.FILE), 'stop() 之后追踪文件应存在');
    const data = JSON.parse(fs.readFileSync(requestTrace.FILE, 'utf8'));
    const arr = data['inst-trace'];
    assert.ok(Array.isArray(arr) && arr.length === 1, `应落盘 1 条，实际 ${arr && arr.length}`);
    assert.strictEqual(arr[0].route, '/api/mobile/v1/probe');
    assert.strictEqual(arr[0].servedBy, 'live');
  });

  await test('没有新条目时再次 stop() 不重复写盘', async () => {
    await stop();
    const data = JSON.parse(fs.readFileSync(requestTrace.FILE, 'utf8'));
    assert.strictEqual(data['inst-trace'].length, 1, '不应重复追加');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
