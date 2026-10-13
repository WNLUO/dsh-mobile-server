'use strict';

/**
 * 镜像槽位状态：中转侧的 `inst.mirror` 是宿主经隧道推来的复合快照
 * （sessions / workspaces / messages / stats / models）。
 *
 * 旧实现只记一个 `inst.mirrorAt`，于是「后台只刷新了其中一个槽位」会把其余
 * 仍然冻结的槽位一起伪装成新鲜——镜像从此再也不会被判定过期，手机永远读到
 * 创建会话那一刻的快照（响应里标着 stale:true，内容却永不前进）。
 *
 * 这里按槽位分别记时间戳：每个槽位各自过期、各自被后台刷新，且刷新回来的
 * 新鲜 body 直接写回该槽位（而不是只写进对这些路径永远读不到的 responseCache）。
 *
 * 空降级保护分两层，谓词同口径：回源写回走 `applyMirrorRefresh`，隧道推送走
 * `installMirror`（推送路径不认识宿主的内部状态，是宿主回归/版本错配/第三方 instance
 * 能把一份空清单推给所有手机的唯一一道防线）。
 */

const { log } = require('./registry.js');

const SLOT_SESSIONS = 'sessions';
const SLOT_WORKSPACES = 'workspaces';
const SLOT_MESSAGES = 'messages';
const SLOT_STATS = 'stats';
const SLOT_MODELS = 'models';

/** messages/stats 按 sessionId 分桶，其余槽位整份共享一个时间戳。 */
const PER_SESSION_SLOTS = new Set([SLOT_MESSAGES, SLOT_STATS]);

/**
 * 空降级宽限：某清单槽位刚被刷新过、不到这么久就回一份空清单时，按「没取到」处理。
 * 取值与响应缓存 TTL（RELAY_CACHE_TTL_MS，默认 30s）对齐：一次抖动最坏被放大成
 * 30s 的权威空清单，正是真机里「侧边栏整树消失、只有下拉刷新能救」那 30s。
 */
const MIRROR_EMPTY_GRACE_MS = Number(process.env.RELAY_MIRROR_EMPTY_GRACE_MS || 30000);

/** body 是不是「成功但空」的清单（items 数组且长度为 0）。 */
function isEmptyListBody(body) {
  return !!body && body.ok === true && Array.isArray(body.items) && body.items.length === 0;
}

/** body 是不是「成功且非空」的清单。 */
function hasListItems(body) {
  return !!body && body.ok === true && Array.isArray(body.items) && body.items.length > 0;
}

/** 路由 → 镜像槽位；不属于镜像缓存的路由返回 null。 */
function slotForPath(pathname) {
  if (pathname === '/api/mobile/v1/sessions') return SLOT_SESSIONS;
  if (pathname === '/api/mobile/v1/workspaces') return SLOT_WORKSPACES;
  if (pathname === '/api/mobile/v1/session/messages') return SLOT_MESSAGES;
  if (pathname === '/api/mobile/v1/session/stats') return SLOT_STATS;
  if (pathname === '/api/mobile/v1/session/models') return SLOT_MODELS;
  return null;
}

/** 带 items 数组的清单槽位：空降级守卫只对它们有意义（messages/stats 是按 session 分桶的映射）。 */
const LIST_SLOTS = [SLOT_SESSIONS, SLOT_WORKSPACES];

/**
 * 推送路径的空降级守卫：整份替换前挡掉「未确认的空清单覆盖非空镜像」。
 *
 * 谓词与 `server.js` 的 `cacheResponse` 完全一致（同样的 `isEmptyListBody`/`hasListItems`，
 * 同样的 `emptyConfirmed === true` 逃生口）：宿主在 body 里显式断言「我确实读到了合法的空」
 * 才放行，否则保留上一份非空清单。这一层是推送路径上唯一的防线——中转不认识宿主的内部
 * 状态，而宿主回归、版本错配或第三方 instance 都能把一份空清单推到所有手机上，症状
 * （侧边栏整树消失、只有下拉刷新能救）在手机侧与真实清空无法区分。
 *
 * 只覆盖 sessions/workspaces：宿主只给这两个 body 写 `emptyConfirmed`
 * （dsh-mobile-plugin/lib/mobile/sessions.js:281、lib/mobile/workspaces.js:78）；
 * messages/stats 的空 body 没有这个断言，对它们套同一谓词会把合法的「这个会话还没有消息」
 * 也一并拒掉。就地改写 mirror，返回被挡下的槽位名供调用方保留原时间戳。
 */
function rejectUnconfirmedEmpty(mirror, previous) {
  const rejected = [];
  for (const slot of LIST_SLOTS) {
    const incoming = mirror && mirror[slot];
    if (!isEmptyListBody(incoming) || incoming.emptyConfirmed === true) continue;
    if (!hasListItems(previous && previous[slot])) continue;
    rejected.push(slot);
    mirror[slot] = previous[slot];
  }
  return rejected;
}

/** 安装一整份镜像（隧道推送 / 磁盘兜底）：所有槽位的时间戳都置为同一时刻。 */
function installMirror(inst, mirror, mirrorAt) {
  const raw = Number(mirrorAt);
  const at = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
  const previous = inst && inst.mirror && typeof inst.mirror === 'object' ? inst.mirror : null;
  const rejected = rejectUnconfirmedEmpty(mirror, previous);
  inst.mirror = mirror;
  inst.mirrorAt = at;
  const table = {
    [SLOT_SESSIONS]: at,
    [SLOT_WORKSPACES]: at,
    [SLOT_MODELS]: at,
    [SLOT_MESSAGES]: {},
    [SLOT_STATS]: {},
  };
  for (const slot of PER_SESSION_SLOTS) {
    const source = mirror && typeof mirror[slot] === 'object' && mirror[slot] ? mirror[slot] : {};
    for (const sessionId of Object.keys(source)) table[slot][sessionId] = at;
  }
  for (const slot of rejected) {
    // 被挡下的槽位内容没换，时间戳就不能跟着前移：否则这份旧清单会被伪装成刚推来的
    // 新鲜镜像，后台刷新也不再触发，等于把「拒绝覆盖」变成「永久冻结」。
    const kept = mirrorSlotAt(inst, slot, undefined);
    table[slot] = kept > 0 ? kept : 0;
    log(`mirror empty overwrite rejected: instance=${inst && inst.instanceId} slot=${slot} — keeping previous non-empty list`);
  }
  inst.mirrorSlotAt = table;
  return at;
}

/**
 * 某槽位（messages/stats 还需 sessionId）最后一次变新鲜的时间。
 * **没有记录就返回 0**，不回退到 `inst.mirrorAt`：`markMirrorSlot` 每刷新一个槽位就会
 * 前移整份快照时间，回退会把「从没收到过这个槽位」报成刚刚更新——空降级宽限判定虚高
 * （刚推来的非空镜像护不住），后台刷新也不再触发。缺失就是缺失。
 */
function mirrorSlotAt(inst, slot, sessionId) {
  const table = inst && inst.mirrorSlotAt;
  if (!table || typeof table !== 'object') return 0;
  if (PER_SESSION_SLOTS.has(slot)) {
    const per = table[slot];
    if (per && typeof per === 'object' && sessionId && Number(per[sessionId]) > 0) return Number(per[sessionId]);
    return 0;
  }
  return Number(table[slot]) > 0 ? Number(table[slot]) : 0;
}

/** 标记某槽位刚被刷新；只前移该槽位（同时前移整份快照时间供状态展示）。 */
function markMirrorSlot(inst, slot, sessionId, at) {
  const table = inst.mirrorSlotAt || (inst.mirrorSlotAt = {});
  const raw = Number(at);
  const stamp = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
  if (PER_SESSION_SLOTS.has(slot)) {
    const per = table[slot] && typeof table[slot] === 'object' ? table[slot] : (table[slot] = {});
    if (sessionId) per[sessionId] = stamp;
  } else {
    table[slot] = stamp;
  }
  inst.mirrorAt = stamp;
  return stamp;
}

/**
 * 把后台刷新回来的新鲜 body 写回它所属的槽位。
 * models 槽位可能是「整份快照」或「按 sessionId 映射」，按当前形状就位更新。
 */
function applyMirrorRefresh(inst, pathname, sessionId, body) {
  if (!body || body.ok !== true) return false;
  const slot = slotForPath(pathname);
  if (!slot) return false;
  // 空降级保护：刚推过非空清单、几秒内却回一份空清单 —— 那是「没取到」而不是
  // 「真被清空」。旧实现只判 `body.ok`，空篮子会被写回并 markMirrorSlot 标成新鲜，
  // 于是中转把空清单冻结 30s 每 15s 喂给 App 一次，App 侧栏整树消失且零报错。
  // 桌面侧每 500ms 推一次，但这里只对**回源**的结果生效（applyMirrorRefresh 只在
  // backgroundRefresh 的 onFresh 里被调用），不拦推送。
  if (isEmptyListBody(body) && hasListItems(inst.mirror && inst.mirror[slot])
    && Date.now() - mirrorSlotAt(inst, slot, sessionId) < MIRROR_EMPTY_GRACE_MS) {
    return false;
  }
  if (!inst.mirror || typeof inst.mirror !== 'object') inst.mirror = {};
  if (PER_SESSION_SLOTS.has(slot)) {
    if (!sessionId) return false;
    const current = inst.mirror[slot];
    const per = current && typeof current === 'object' ? current : (inst.mirror[slot] = {});
    per[sessionId] = body;
  } else if (slot === SLOT_MODELS) {
    const models = inst.mirror.models;
    if (models && models.ok === true) inst.mirror.models = body;
    else if (models && sessionId && models[sessionId]) models[sessionId] = body;
    else inst.mirror.models = body;
  } else {
    inst.mirror[slot] = body;
  }
  markMirrorSlot(inst, slot, sessionId, Date.now());
  return true;
}

/**
 * 镜像刷新用的规范 URL：只保留 sessionId，丢掉 afterSeq/beforeSeq/limit 这类分页参数。
 * 镜像存的是快照，若把「已按 afterSeq 过滤过的」响应写回去，快照会越刷越小。
 */
function mirrorCanonicalUrl(pathname, sessionId) {
  const query = new URLSearchParams();
  if (sessionId) query.set('sessionId', sessionId);
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

module.exports = {
  SLOT_SESSIONS,
  SLOT_WORKSPACES,
  SLOT_MESSAGES,
  SLOT_STATS,
  SLOT_MODELS,
  MIRROR_EMPTY_GRACE_MS,
  isEmptyListBody,
  hasListItems,
  slotForPath,
  installMirror,
  mirrorSlotAt,
  markMirrorSlot,
  applyMirrorRefresh,
  mirrorCanonicalUrl,
};
