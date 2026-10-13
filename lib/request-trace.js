'use strict';

/**
 * 移动端读请求追踪（relay 端，独立于 app 上报的诊断）。
 *
 * relay 为每个 cacheable 移动 API 读请求记录：路径、会话、命中方式（mirror/cache/live）、
 * 状态码、relay 处理耗时、以及回源到桌面的上行等待耗时（upstreamMs）——后者是判断
 * 「手机是否被忙碌桌面拖慢」的关键指标。
 *
 * 落盘到 PLUGIN_OTA_ROOT/request-trace.json（目录名沿用历史名：它以前装的是插件 OTA 资产，
 * 2026-10 插件改走 npm 之后这个根目录只剩运维数据了，改名会移动线上文件、不值当），重启不丢；控制面经
 * GET /api/desktop-plugins/control/request-trace 读取。
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.REQUEST_TRACE_FILE
  || path.join(process.env.PLUGIN_OTA_ROOT || path.join(__dirname, '..', 'plugin-ota'), 'request-trace.json');
const MAX_TRACE = 500; // 每个实例最多保留最近 N 条

let loaded = false;
let data = {}; // instanceId -> [{at, route, sessionId, method, servedBy, status, latencyMs, upstreamMs, stale}]

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    data = {};
  }
}

let saveTimer = null;
let dirty = false;

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch { /* 追踪失败不影响主链路 */ }
}

function save() {
  // 每个 cacheable 读请求都同步重写整个 JSON 文件，会把请求路径放大的磁盘 I/O
  // 变成性能瓶颈。改为合并到 1s 窗口，只在确实有新条目时落盘一次。
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function record(instanceId, entry) {
  load();
  const arr = data[instanceId] || (data[instanceId] = []);
  arr.push({ at: Date.now(), ...entry });
  if (arr.length > MAX_TRACE) arr.splice(0, arr.length - MAX_TRACE);
  save();
}

function list(instanceId) {
  load();
  return instanceId ? { [instanceId]: (data[instanceId] || []) } : data;
}

module.exports = { FILE, record, list, flush: saveNow };
