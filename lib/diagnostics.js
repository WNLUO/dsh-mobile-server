'use strict';

/**
 * 移动端连接诊断存储（relay 端）。
 *
 * 手机 App 把每次移动 API/流的路由尝试、耗时、状态码与错误，连同设备快照
 * POST 到 /api/mobile/v1/diagnostics；这里按桌面 instanceId 落盘，供控制面读取。
 * 只存元数据 + 最近的诊断条目，不存 token/cookie 等敏感字段。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.DIAGNOSTICS_FILE
  || path.join(process.env.PLUGIN_OTA_ROOT || path.join(__dirname, '..', 'plugin-ota'), 'diagnostics.json');
const MAX_INSTANCES = 60;
const MAX_ENTRIES = 200;

let loaded = false;
let data = {};

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

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function push(instanceId, snapshot, entries) {
  load();
  data[instanceId] = {
    snapshot: snapshot && typeof snapshot === 'object' ? snapshot : {},
    entries: (Array.isArray(entries) ? entries : []).slice(-MAX_ENTRIES),
    updatedAt: Date.now(),
  };
  const keys = Object.keys(data);
  if (keys.length > MAX_INSTANCES) {
    keys.sort((a, b) => data[a].updatedAt - data[b].updatedAt);
    for (const k of keys.slice(0, keys.length - MAX_INSTANCES)) delete data[k];
  }
  save();
}

function list() {
  load();
  return data;
}

module.exports = { FILE, push, list };
