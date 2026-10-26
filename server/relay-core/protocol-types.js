'use strict';

/**
 * DSH 隧道协议 v2 —— 帧类型表与线格式常量（唯一事实源）。
 *
 * 这个文件里只有数据和纯规则，**不碰任何运行时 API**（没有 Buffer、没有
 * Uint8Array、没有 crypto）。Rust 中转按镜像常量实现，独立发布的宿主插件内联
 * 类型表和 Buffer 编解码；变更编号须同步 Rust 与插件，并运行协议对撞测试。
 *
 * 线格式：每条隧道消息 = 一个 WS binary 帧
 *   [type: 1B][id: 4B 大端][length: 4B 大端][payload: length B]
 *
 * 协议语义见同目录 PROTOCOL.md。
 */

/** 帧类型编号。id=0 表示无请求号（控制帧），id=N 表示对应某次请求。 */
const T = {
  register: 0x01,      // id=0  JSON {instanceId, pairingCode, name, lanUrls?, lanCandidates?}
  registered: 0x02,    // id=0  JSON {}
  updatePairing: 0x03, // id=0  JSON {pairingCode}
  httpRequest: 0x04,   // id=N  JSON {method, path, headers}；body 随后以 httpBody 流式发送
  httpBody: 0x05,      // id=N  raw bytes（空 payload = body 结束）
  httpHead: 0x06,      // id=N  JSON {status, headers}
  httpChunk: 0x07,     // id=N  raw bytes
  httpEnd: 0x08,       // id=N  空
  httpError: 0x09,     // id=N  JSON {message}
  wsUpgrade: 0x0A,     // id=N  JSON {path, headers}
  wsOpen: 0x0B,        // id=N  空
  wsError: 0x0C,       // id=N  JSON {message}
  wsText: 0x0D,        // id=N  raw bytes（上游 WS 文本帧数据）
  wsBinary: 0x0E,      // id=N  raw bytes（上游 WS 二进制帧数据）
  wsClose: 0x0F,       // id=N  2B 大端 close code
  ping: 0x10,          // id=0  空
  pong: 0x11,          // id=0  空
  pairRequest: 0x12,   // id=0  JSON {requestId, device:{id?, deviceId?, name?, platform?, osVersion?, appVersion?, ip?}}（手机配对 → 请求桌面授权；ip 由中转注入）
  pairConfirm: 0x13,   // id=0  JSON {requestId, approved, token?}（桌面授权结果 → 中转 → 手机）
  httpCancel: 0x14,    // id=N  空；取消上游 HTTP 请求/响应
  httpPause: 0x15,     // id=N  空；暂停向中转发送响应数据
  httpResume: 0x16,    // id=N  空；恢复向中转发送响应数据
  sync: 0x17,          // id=0  JSON {kind, ...}；桌面→中转主动推送（移动端镜像缓存）
  revokeAll: 0x18,     // id=0  JSON {at}；桌面请求中转清空本实例全部设备授权
  revokeAllAck: 0x19,  // id=0  JSON {ok, revoked}；中转确认已清空
  pushRegister: 0x1A,  // id=0  JSON {deviceId, platform, token}；宿主代 App 上报 iOS 推送令牌（本实例）
  pushSend: 0x1B,      // id=0  JSON {deviceId, title, body, sessionId?, kind}；宿主请求中转发一条 APNs 推送
};

/** 编号 → 名字的反查表。 */
const TYPE_NAME = {};
for (const [name, code] of Object.entries(T)) TYPE_NAME[code] = name;

/** 帧头长度：type 1B + id 4B + length 4B。 */
const HEADER_LEN = 9;

/** WS 关闭帧 reason 上限 123 字节（RFC 6455 控制帧 125 字节减去 2 字节 code）。 */
const MAX_CLOSE_REASON_BYTES = 123;

/** 1005/1006/1015 是保留值，不得出现在线上；1004 语义不明，ws 同样拒绝。 */
const RESERVED_CLOSE_CODES = [1004, 1005, 1006, 1015];

/** close code 是否可出现在线上（ws 对保留值/越界值会直接抛错）。 */
function validCloseCode(code) {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 && !RESERVED_CLOSE_CODES.includes(code);
}

/**
 * 压掉重复斜杠、去掉尾斜杠。
 *
 * 用户把中转地址填成 `https://host/`、或者粘贴时多带一个尾斜杠，拼出来就是 `//pair`。
 * **宿主用的是 URL 解析器**（`new URL(req.url, base).pathname`）：`//pair` 会被当成
 * 协议相对地址解析成 `/`，`//api/mobile/v1/status` 会被解析成 `/api/mobile/v1/status`。
 * 中转是路径的出口，在这里压一次，宿主就永远收不到双斜杠。`/` 不压成空串。
 */
function normalizePath(pathname) {
  const collapsed = String(pathname).replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

/** 中转自己认领的路径。与帧编号无关，但同属「三端必须一致」的规则，所以放在一起。 */
const OWNED_PATHS = ['/', '/healthz', '/status', '/api/mobile/v1/health', '/api/mobile/v1/push-token', '/tunnel'];

/**
 * 手机 API 的固定前缀。`/health` 是 405 那条，这一条是「整段手机 API」。
 *
 * 单独放一条是因为部署前缀也可能**落在中间**：中转地址被填成 `https://host/relay`
 * 时，路径长成 `/relay/api/mobile/v1/sessions`。
 * 只按「以认领路径结尾」判的话这一条命中不了，而它正是几乎全部真实流量。
 */
const MOBILE_PREFIX = '/api/mobile/v1/';

/**
 * 从请求路径里剥掉部署前缀，返回中转认得的路径（只给中转自己判路由用）。
 *
 * 中转不解释业务，只认自己那几条路径，所以判据看**末尾**：路径以某个认领路径结尾就算
 * 那个路径。其余路径原样返回。
 */
function stripDeployPrefix(pathname) {
  if (OWNED_PATHS.includes(pathname)) return pathname;
  const match = OWNED_PATHS.find((owned) => owned !== '/' && pathname.endsWith(owned));
  return match || pathname;
}

/**
 * 送给宿主的路径：剥掉部署前缀，保留查询串。
 *
 * 与 `stripDeployPrefix` 分开是因为命中面不同：判路由时短路径有歧义（`/relay/some/status`
 * 也会命中 `/status`），送给宿主时只按 `/api/mobile/v1/` 剥就不会误伤——宿主只认这个前缀
 * 下的路径，带前缀的一律 404。
 */
function routedPath(pathname, search = '') {
  const normalized = normalizePath(pathname);
  const stripped = stripDeployPrefix(normalized);
  if (stripped !== normalized) return `${stripped}${search}`;
  const at = normalized.indexOf(MOBILE_PREFIX);
  if (at > 1) return `${normalized.slice(at)}${search}`;
  return `${normalized}${search}`;
}

module.exports = {
  T,
  TYPE_NAME,
  HEADER_LEN,
  MAX_CLOSE_REASON_BYTES,
  RESERVED_CLOSE_CODES,
  validCloseCode,
  OWNED_PATHS,
  MOBILE_PREFIX,
  normalizePath,
  stripDeployPrefix,
  routedPath,
};
