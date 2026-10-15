'use strict';

/**
 * 隧道帧分发：把桌面端经隧道推回来的帧分发给等待中的 HTTP 响应 / 手机 WS。
 *
 * 依赖方向：protocol + registry + pair + bridge-ws（sendWsFrame）。
 *
 * 镜像推送（T.sync）是**单向帧**：协议里没有 syncAck，宿主那边只要隧道写得进去就认为
 * 推成功。所以中转侧唯一能留下证据的地方就是这里 —— 清洗失败必须记日志并计数
 * （`mirrorSyncStats`），否则「手机一直读到旧镜像、宿主日志一切正常」这种故障在两边
 * 都查不到线索。
 */

const { WebSocket } = require('ws');
const fs = require('node:fs');
const path = require('node:path');
const { T, parseJson, decodeClosePayload } = require('./protocol.js');
const { log } = require('./registry.js');
const { signPair, setPairCookie } = require('./pair.js');
const { sanitizeRespHeaders, sendTunnelFrame, armSseIdle } = require('./proxy-http.js');
const { sendWsFrame } = require('./bridge-ws.js');
const { installMirror } = require('./mirror-state.js');
const credentials = require('../../dsh-mobile-plugin/dsh-mobile-credentials/lib/credentials.js');

const MAX_MIRROR_BYTES = 4 * 1024 * 1024;
const MAX_MIRROR_MAP_ENTRIES = 32;
const MAX_MIRROR_SESSION_ITEMS = 4096;
const MAX_MIRROR_WORKSPACE_ITEMS = 1024;
const MAX_MIRROR_MESSAGE_ITEMS = 512;
const MAX_MIRROR_MODEL_GROUPS = 128;
const MAX_MIRROR_MODELS_PER_GROUP = 256;
const MAX_MIRROR_MODEL_FAILURES = 64;
const MIRROR_DATA_DIR = process.env.MIRROR_DATA_DIR || path.join(__dirname, '..', 'data');

function mirrorRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const MAX_PROJECTION_ARRAY = 512;
const MAX_PROJECTION_TEXT = 8192;
const PROJECTION_SCALARS = new Set([
  'tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'contextWindow', 'pressureTokens', 'projectedTokens', 'turns', 'steps',
  'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens',
]);

function projectionText(value, max = MAX_PROJECTION_TEXT) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function projectionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value : undefined;
}

function projectionNumbers(value, keys) {
  if (!mirrorRecord(value)) return undefined;
  const result = {};
  for (const key of keys) {
    const number = projectionNumber(value[key]);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizePermissions(value) {
  if (!mirrorRecord(value)) return undefined;
  const result = {};
  if (Array.isArray(value.options)) {
    result.options = value.options.slice(0, 32).map((option) => {
      if (!mirrorRecord(option)) return null;
      const item = {};
      const optionValue = projectionText(option.value, 256);
      const name = projectionText(option.name, 512);
      const description = projectionText(option.description, 2048);
      if (optionValue !== undefined) item.value = optionValue;
      if (name !== undefined) item.name = name;
      if (description !== undefined) item.description = description;
      return Object.keys(item).length ? item : null;
    }).filter(Boolean);
  }
  const currentValue = projectionText(value.currentValue, 256);
  if (currentValue !== undefined) result.currentValue = currentValue;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeGoal(value) {
  if (!mirrorRecord(value) || !(value.goal === null || mirrorRecord(value.goal))) return undefined;
  if (value.goal === null) return { goal: null };
  const result = {};
  const id = projectionText(value.goal.id, 256);
  const objective = projectionText(value.goal.objective);
  if (id !== undefined) result.id = id;
  if (Number.isSafeInteger(value.goal.revision) && value.goal.revision >= 0) result.revision = value.goal.revision;
  if (['active', 'paused', 'blocked', 'complete'].includes(value.goal.phase)) result.phase = value.goal.phase;
  if (objective !== undefined) result.objective = objective;
  if (mirrorRecord(value.goal.blockedReason)) {
    const message = projectionText(value.goal.blockedReason.message);
    if (message !== undefined) result.blockedReason = { message };
  }
  return { goal: result };
}

function sanitizeTodos(value) {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, MAX_PROJECTION_ARRAY).map((todo) => {
    if (!mirrorRecord(todo) || !['pending', 'in_progress', 'completed'].includes(todo.status)) return null;
    const content = projectionText(todo.content);
    return content === undefined ? null : { content, status: todo.status };
  }).filter(Boolean);
  return items;
}

function sanitizeProjections(value) {
  if (!mirrorRecord(value)) return undefined;
  const result = {};
  const fields = [
    ['tokenUsage', ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']],
    ['contextPressure', ['contextWindow', 'pressureTokens', 'projectedTokens']],
    ['contextBreakdown', ['systemTokens', 'toolsTokens', 'messageTokens']],
    ['sessionStats', ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens']],
  ];
  for (const [name, keys] of fields) {
    const safe = projectionNumbers(value[name], keys);
    if (safe) result[name] = safe;
  }
  const permissions = sanitizePermissions(value.permissions);
  if (permissions) result.permissions = permissions;
  if (mirrorRecord(value.planMode) && typeof value.planMode.active === 'boolean') {
    result.planMode = { active: value.planMode.active, ...(typeof value.planMode.pending === 'boolean' ? { pending: value.planMode.pending } : {}) };
  }
  const goal = sanitizeGoal(value.goal);
  if (goal) result.goal = goal;
  const todos = sanitizeTodos(value.todos);
  if (todos) result.todos = todos;
  for (const key of PROJECTION_SCALARS) {
    const number = projectionNumber(value[key]);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function mirrorBody(value, itemLimit) {
  if (!mirrorRecord(value)) return null;
  const result = {};
  if (typeof value.ok === 'boolean') result.ok = value.ok;
  if (Array.isArray(value.items)) result.items = value.items.slice(0, itemLimit);
  for (const key of ['lastSeq', 'oldestSeq']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (typeof value.hasMore === 'boolean') result.hasMore = value.hasMore;
  if (typeof value.resyncRequired === 'boolean') result.resyncRequired = value.resyncRequired;
  // 显式空态必须一起过桥。宿主在 sessions/workspaces 的 body 里写 `emptyConfirmed:
  // items.length === 0`（dsh-mobile-plugin/lib/mobile/sessions.js:281），它是「这份空是
  // 真的读到了空」的唯一断言。中转的空降级守卫（mirror-state.installMirror）要靠它把
  // 「用户真清空了」和「上游抖了一下回了空」分开；字段一旦在这里被清洗掉，守卫就只能
  // 一律拒绝（合法清空永远同步不出去）或一律放行（等于没有守卫）。
  if (typeof value.emptyConfirmed === 'boolean') result.emptyConfirmed = value.emptyConfirmed;
  const projections = sanitizeProjections(value.projections);
  if (projections) result.projections = projections;
  return result;
}

function mirrorMap(value, itemLimit) {
  if (!mirrorRecord(value)) return {};
  const result = Object.create(null);
  for (const [key, body] of Object.entries(value).slice(0, MAX_MIRROR_MAP_ENTRIES)) {
    if (key.length > 256) continue;
    const safe = mirrorBody(body, itemLimit);
    if (safe) result[key] = safe;
  }
  return result;
}

function sanitizeModel(value) {
  if (!mirrorRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  const result = { id: projectionText(value.id, 512), name: projectionText(value.name, 512) };
  if (typeof value.description === 'string') result.description = value.description.slice(0, MAX_PROJECTION_TEXT);
  if (mirrorRecord(value.reasoning) && Array.isArray(value.reasoning.efforts)) {
    result.reasoning = { efforts: value.reasoning.efforts.slice(0, 64).map((effort) => {
      if (!mirrorRecord(effort) || typeof effort.id !== 'string' || typeof effort.name !== 'string') return null;
      const item = { id: projectionText(effort.id, 256), name: projectionText(effort.name, 512) };
      if (typeof effort.description === 'string') item.description = effort.description.slice(0, 4096);
      return item;
    }).filter(Boolean) };
    if (typeof value.reasoning.defaultEffort === 'string') result.reasoning.defaultEffort = projectionText(value.reasoning.defaultEffort, 256);
  }
  return result;
}
function sanitizeModels(value) {
  if (!mirrorRecord(value)) return undefined;
  const result = {};
  if (typeof value.ok === 'boolean') result.ok = value.ok;
  if (mirrorRecord(value.current)) { result.current = {}; for (const [key, max] of [['provider', 256], ['model', 512], ['reasoningEffort', 256]]) { const text = projectionText(value.current[key], max); if (text !== undefined) result.current[key] = text; } }
  if (typeof value.routable === 'boolean') result.routable = value.routable;
  if (Array.isArray(value.groups)) result.groups = value.groups.slice(0, MAX_MIRROR_MODEL_GROUPS).map((group) => {
    if (!mirrorRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)) return null;
    return { id: projectionText(group.id, 256), name: projectionText(group.name, 512), models: group.models.slice(0, MAX_MIRROR_MODELS_PER_GROUP).map(sanitizeModel).filter(Boolean) };
  }).filter(Boolean);
  if (Array.isArray(value.failures)) result.failures = value.failures.slice(0, MAX_MIRROR_MODEL_FAILURES).map((failure) => {
    if (!mirrorRecord(failure)) return {}; const item = {}; for (const [key, max] of [['id', 256], ['name', 512], ['message', MAX_PROJECTION_TEXT]]) { const text = projectionText(failure[key], max); if (text !== undefined) item[key] = text; } return item;
  });
  if (Number.isSafeInteger(value.revision) && value.revision >= 0) result.revision = value.revision;
  if (mirrorRecord(value.meta)) { const meta = {}; for (const key of ['source']) { const text = projectionText(value.meta[key], 256); if (text !== undefined) meta[key] = text; } if (Number.isSafeInteger(value.meta.age) && value.meta.age >= 0) meta.age = value.meta.age; if (Number.isSafeInteger(value.meta.revision) && value.meta.revision >= 0) meta.revision = value.meta.revision; if (Object.keys(meta).length) result.meta = meta; }
  return result;
}
function sanitizeModelsMap(value) {
  if (!mirrorRecord(value)) return {}; const result = Object.create(null);
  for (const [key, body] of Object.entries(value).slice(0, MAX_MIRROR_MAP_ENTRIES)) { if (key.length > 256) continue; const safe = sanitizeModels(body); if (safe) result[key] = safe; } return result;
}

const MIRROR_SLOT_KEYS = ['sessions', 'workspaces', 'messages', 'stats', 'models'];

/**
 * 镜像推送的成败计数。T.sync 是单向帧（协议里没有 syncAck），宿主只要隧道写得进去
 * 就认为推成功、`mirror.ok` 保持为真；清洗失败原本连一行日志都没有，于是
 * 「宿主说推了 / 手机一直读旧的」这种故障在两侧都无迹可查。这里把计数与最后一次
 * 丢弃的原因留在中转进程里（`GET /api/relay/status` 与排查都用得上）。
 */
const mirrorSyncStats = { accepted: 0, dropped: 0, lastDroppedAt: 0, lastDropReason: '', lastDroppedBytes: 0 };

/** 清洗的详细结果：`{ mirror, reason }`；reason 只用于日志与计数，成功时为空串。 */
function sanitizeMirrorDetailed(value) {
  if (!mirrorRecord(value)) return { mirror: null, reason: 'not-an-object' };
  // 五个槽位一个都没有，说明这根本不是镜像载荷。若照常 install，已有镜像会被整份替换成
  // 空壳（`parseJson` 失败返回的 `{}` 正好会走到这里），手机下一次读镜像直接落空回源。
  if (!MIRROR_SLOT_KEYS.some((key) => value[key] !== undefined && value[key] !== null)) {
    return { mirror: null, reason: 'no-mirror-slots' };
  }
  const mirror = {
    kind: 'sync',
    at: Number.isSafeInteger(value.at) && value.at >= 0 ? value.at : Date.now(),
    activeSessionId: typeof value.activeSessionId === 'string' ? value.activeSessionId.slice(0, 256) : null,
  };
  const sessions = mirrorBody(value.sessions, MAX_MIRROR_SESSION_ITEMS);
  const workspaces = mirrorBody(value.workspaces, MAX_MIRROR_WORKSPACE_ITEMS);
  if (sessions) mirror.sessions = sessions;
  if (workspaces) mirror.workspaces = workspaces;
  mirror.messages = mirrorMap(value.messages, MAX_MIRROR_MESSAGE_ITEMS);
  mirror.stats = mirrorMap(value.stats, 0);
  // Accept per-session maps, active-session snapshots, and global snapshots.
  if (mirrorRecord(value.models) && value.models.ok === true) {
    mirror.models = sanitizeModels(value.models) || {};
  } else {
    mirror.models = sanitizeModelsMap(value.models);
  }
  try {
    if (Buffer.byteLength(JSON.stringify(mirror), 'utf8') > MAX_MIRROR_BYTES) {
      return { mirror: null, reason: 'over-max-bytes' };
    }
  } catch {
    return { mirror: null, reason: 'not-serializable' };
  }
  return { mirror, reason: '' };
}

function sanitizeMirror(value) {
  return sanitizeMirrorDetailed(value).mirror;
}

// ── 镜像磁盘持久化 ──────────────────────────────────────────────
function saveMirrorToDisk(instanceId, mirror, mirrorAt) {
  const dir = MIRROR_DATA_DIR;
  const filePath = path.join(dir, `mirror-${instanceId}.json`);
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) {
      log(`failed to create mirror data directory: ${err.message}`);
      return;
    }
    fs.writeFile(filePath, JSON.stringify({ mirror, mirrorAt }), 'utf8', (err) => {
      if (err) log(`failed to write mirror to disk: ${err.message}`);
    });
  });
}

function loadMirrorFromDisk(instanceId) {
  const filePath = path.join(MIRROR_DATA_DIR, `mirror-${instanceId}.json`);
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && parsed.mirror && typeof parsed.mirror === 'object') {
      return { mirror: parsed.mirror, mirrorAt: parsed.mirrorAt || 0 };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`failed to read mirror from disk: ${err.message}`);
    }
  }
  return null;
}

const PAIR_APPROVAL_TIMEOUT_MS = 90_000; // 等待桌面端弹窗授权的最长时间

function failAllPending(inst, reason) {
  for (const [, entry] of inst.pending) {
    if (entry.kind === 'http') {
      try {
        entry.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        entry.res.end(`upstream unavailable: ${reason}`);
      } catch {
        try { entry.res.destroy?.(); } catch { /* ignore */ }
      }
    } else if (entry.kind === 'ws' && entry.phone.readyState === WebSocket.OPEN) {
      try { entry.phone.close(1011, reason); } catch {
        try { entry.phone.terminate?.(); } catch { /* ignore */ }
      }
    }
  }
  inst.pending.clear();
  // 未决的配对授权请求（手机在等桌面端弹窗）一并失败
  for (const [, p] of inst.pendingPairs) {
    clearTimeout(p.timer);
    try {
      p.res.writeHead(503, { 'content-type': 'application/json' });
      p.res.end(JSON.stringify({ ok: false, error: '桌面端离线' }));
    } catch { /* 已关闭 */ }
  }
  inst.pendingPairs.clear();
}
function handleTunnelFrame(inst, frame) {
  try {
    handleTunnelFrameInner(inst, frame);
  } catch (err) {
    // 单条消息异常不得拖垮整个 relay 进程
    log('tunnel frame error:', err.message);
  }
}
function handleTunnelFrameInner(inst, frame) {
  const { type, id, payload } = frame;
  const entry = inst.pending.get(id);
  switch (type) {
    case T.pairConfirm: {
      // 桌面端弹窗授权结果：把 token（或拒绝）回给等待中的手机 /pair 请求
      const msg = parseJson(payload);
      const p = inst.pendingPairs.get(msg.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      inst.pendingPairs.delete(msg.requestId);
      if (msg.approved && typeof msg.token === 'string' && msg.token) {
        const issued = credentials.issue(inst.instanceId, p.device, msg.token);
        const cookieValue = signPair(inst.instanceId, issued.deviceId);
        setPairCookie(p.res, inst.instanceId, issued.deviceId, p.secure);
        try {
          p.res.writeHead(200, { 'content-type': 'application/json' });
          // cookie 同时放进 body：RN fetch 读不到 Set-Cookie 响应头，App 需自行携带
          p.res.end(JSON.stringify({ ok: true, instanceId: inst.instanceId, token: msg.token, cookie: `dsh_pair=${cookieValue}`, deviceId: issued.deviceId, deviceCredential: issued.credential, ...(typeof msg.hostPlatform === 'string' && msg.hostPlatform ? { hostPlatform: msg.hostPlatform } : {}), ...(inst.lanUrls?.length ? { lanUrls: inst.lanUrls } : {}), ...(inst.lanCandidates?.length ? { lanCandidates: inst.lanCandidates } : {}) }));
        } catch { /* 已关闭 */ }
        log(`pair approved: ${inst.instanceId} <- ${p.device?.name || p.device?.ip || 'unknown'}`);
      } else {
        try {
          p.res.writeHead(403, { 'content-type': 'application/json' });
          p.res.end(JSON.stringify({ ok: false, error: '桌面端已拒绝此连接请求' }));
        } catch { /* 已关闭 */ }
        log(`pair rejected: ${inst.instanceId} <- ${p.device?.name || p.device?.ip || 'unknown'}`);
      }
      break;
    }
    case T.updatePairing: {
      // 配对码更新：仅接受 6 位数字；旧码即刻失效（桌面端 regenerate 后经隧道同步）
      const msg = parseJson(payload);
      const code = String(msg.pairingCode || '');
      if (/^\d{6}$/.test(code)) {
        inst.pairingCode = code;
        log(`pairing code updated: ${inst.instanceId}`);
      }
      break;
    }
    case T.httpHead: {
      if (!entry || entry.kind !== 'http' || entry.started || entry.cancelled) return;
      const msg = parseJson(payload);
      entry.started = true;
      if (entry.headerTimer) clearTimeout(entry.headerTimer);
      entry.res.writeHead(msg.status || 502, sanitizeRespHeaders(msg.headers));
      armSseIdle(inst, id, entry);
      break;
    }
    case T.httpChunk: {
      if (!entry || entry.kind !== 'http' || !entry.started || entry.cancelled) return;
      const writable = entry.res.write(payload);
      armSseIdle(inst, id, entry);
      if (!writable && !entry.paused) {
        entry.paused = true;
        sendTunnelFrame(inst, T.httpPause, id, Buffer.alloc(0));
      }
      break;
    }
    case T.httpEnd: {
      if (!entry || entry.kind !== 'http') return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      inst.pending.delete(id);
      try { entry.res.end(); } catch { /* ignore */ }
      break;
    }
    case T.httpError: {
      if (!entry) return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      inst.pending.delete(id);
      if (entry.kind === 'http') {
        const msg = parseJson(payload);
        try {
          if (!entry.started) entry.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          entry.res.end(`upstream error: ${msg.message || ''}`);
        } catch { /* ignore */ }
      } else if (entry.phone.readyState === WebSocket.OPEN) {
        const msg = parseJson(payload);
        entry.phone.close(1011, msg.message || 'upstream error');
      }
      break;
    }
    case T.wsOpen: {
      if (!entry || entry.kind !== 'ws' || entry.ready) return;
      entry.ready = true;
      // 未 ready 期间排队的上行帧必须在这一刻冲出去。此前忽略 sendWsFrame 的返回值：
      // 隧道缓冲压满时这些帧静默消失，手机侧只看到「连接建立成功但第一条消息没到」，
      // 日志里一行都没有。隧道写不进去就断开这条手机 WS（与 bridge-ws 的实时路径同口径），
      // 让客户端重连重发，而不是留下一段看起来正常的假连接。
      let delivered = true;
      for (const q of entry.queued) {
        if (!sendWsFrame(inst, id, q)) { delivered = false; break; }
      }
      const queuedBytes = entry.queuedBytes;
      entry.queued = [];
      entry.queuedBytes = 0;
      if (!delivered) {
        log(`ws open queue flush failed: instance=${inst.instanceId} id=${id} queuedBytes=${queuedBytes}`);
        inst.pending.delete(id);
        try { entry.phone.close(1013, 'relay buffer limit exceeded'); } catch { /* ignore */ }
      }
      break;
    }
    case T.wsText:
    case T.wsBinary: {
      if (!entry || entry.kind !== 'ws' || entry.phone.readyState !== WebSocket.OPEN) return;
      if (Number(entry.phone.bufferedAmount || 0) > 16 * 1024 * 1024) {
        try { entry.phone.close(1013, 'relay buffer limit exceeded'); } catch { /* ignore */ }
        inst.pending.delete(id);
        return;
      }
      try { entry.phone.send(payload, { binary: type === T.wsBinary }); } catch {
        try { entry.phone.terminate(); } catch { /* ignore */ }
      }
      break;
    }
    case T.wsClose: {
      if (!entry || entry.kind !== 'ws') return;
      inst.pending.delete(id);
      // 上游可能传非法/缺失 code（曾导致 close(NaN) 崩溃整个 relay）
      const { code, raw, reason, validCode } = decodeClosePayload(payload);
      if (!validCode) log(`wsClose 收到非法 code: ${raw}`);
      if (entry.phone.readyState === WebSocket.OPEN) entry.phone.close(code, reason);
      break;
    }
    case T.wsError: {
      // 宿主侧 WS 升级/传输失败。此前没有这个分支：帧被 default 静默丢弃，
      // 手机的 socket 会一直挂到超时，并且 inst.pending 条目不回收。
      if (!entry || entry.kind !== 'ws') return;
      inst.pending.delete(id);
      const msg = parseJson(payload) || {};
      const reason = String(msg.message || 'upstream websocket error').slice(0, 120);
      try {
        if (entry.phone.readyState === WebSocket.OPEN) entry.phone.close(1011, reason);
        else entry.phone.terminate();
      } catch { /* ignore */ }
      break;
    }
    case T.sync: {
      // 宿主端主动推送(移动端镜像缓存): desktop -> relay -> 手机App读镜像。
      const msg = parseJson(payload);
      const { mirror, reason } = sanitizeMirrorDetailed(msg);
      if (mirror) {
        mirrorSyncStats.accepted += 1;
        installMirror(inst, mirror, Date.now());
        // 异步持久化到磁盘，不阻塞正常流程
        saveMirrorToDisk(inst.instanceId, mirror, inst.mirrorAt);
      } else {
        // T.sync 没有回执帧，宿主只看到「隧道写得进去」就认为推成功。丢弃必须在这里
        // 留下可定位的现场，否则「宿主日志说推了 / 手机一直读旧镜像」两边都无迹可查。
        const bytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload || ''));
        mirrorSyncStats.dropped += 1;
        mirrorSyncStats.lastDroppedAt = Date.now();
        mirrorSyncStats.lastDropReason = reason;
        mirrorSyncStats.lastDroppedBytes = bytes;
        log(`mirror sync dropped: instance=${inst.instanceId} reason=${reason} bytes=${bytes}`);
      }
      break;
    }
    case T.revokeAll: {
      // 桌面端清除所有授权：清空本实例全部设备授权记录，并回执。
      const revokedCount = credentials.revokeAllByInstance(inst.instanceId);
      log('revoke-all: ' + inst.instanceId + ' (' + revokedCount + ')');
      sendTunnelFrame(inst, T.revokeAllAck, 0, { ok: true, revoked: revokedCount });
      break;
    }
    default:
      break;
  }
}

module.exports = {
  failAllPending,
  handleTunnelFrame,
  loadMirrorFromDisk,
  mirrorSyncStats,
  sanitizeMirrorDetailed,
  PAIR_APPROVAL_TIMEOUT_MS,
};