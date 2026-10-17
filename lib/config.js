'use strict';

/**
 * 中转服务器的环境变量配置（限额的唯一真源）。
 *
 * 自建版是一个纯转发：没有密钥、没有准入、不缓存任何东西，所以这里剩下的只是
 * 「一次能收多少、等多久」。
 *
 * 为什么所有可调项都走 `positiveInt`：越界直接抛错、**不是** clamp。一个手滑的 0 或负值
 * 若被静默接受，表现是限额「关掉」而不是「设错」（例如 MAX_PENDING=0 会让全部手机请求
 * 429），启动即失败才留得下现场。
 */

function positiveInt(name, fallback, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

module.exports = {
  MAX_FRAME_BYTES: positiveInt('MAX_FRAME_BYTES', 8 * 1024 * 1024, 64 * 1024 * 1024),
  MAX_BODY_BYTES: positiveInt('MAX_BODY_BYTES', 50 * 1024 * 1024, 256 * 1024 * 1024),
  // 一条隧道上同时在途的请求数（HTTP + WS）；超过就 429 / 1013。
  MAX_PENDING: positiveInt('MAX_PENDING', 256, 100_000),
  MAX_WS_CONNECTIONS: positiveInt('MAX_WS_CONNECTIONS', 256, 10_000),
  MAX_WS_MESSAGE_BYTES: positiveInt('MAX_WS_MESSAGE_BYTES', 8 * 1024 * 1024, 64 * 1024 * 1024),
  MAX_WS_QUEUE_BYTES: positiveInt('MAX_WS_QUEUE_BYTES', 16 * 1024 * 1024, 128 * 1024 * 1024),
  // 手机侧 WS 保活：ping 周期 + 「多久没 pong 也没上行帧」就认定半开。只发 ping 不判 pong
  // 会让半开连接一直停在 OPEN，永久占着 pending 名额，手机重连继续被拒。
  WS_HEARTBEAT_MS: positiveInt('WS_HEARTBEAT_MS', 15_000, 600_000),
  WS_PONG_TIMEOUT_MS: positiveInt('WS_PONG_TIMEOUT_MS', 60_000, 600_000),
  // 隧道心跳。两侧超时**刻意不对称**（中转 60s < 宿主 90s）：反了会在网络抖动时互相
  // terminate 并反复重连。
  TUNNEL_HEARTBEAT_MS: positiveInt('TUNNEL_HEARTBEAT_MS', 15_000, 600_000),
  TUNNEL_PONG_TIMEOUT_MS: positiveInt('TUNNEL_PONG_TIMEOUT_MS', 60_000, 600_000),
  // 一条隧道上同时开着的 SSE 条数。一次对话占一条，多余的重连应当快速失败，
  // 好把名额留给短请求。
  MAX_SSE_CONNECTIONS: positiveInt('MAX_SSE_CONNECTIONS', 16, 10_000),
  // 等宿主回响应头的上限，**对 SSE 同样适用**：宿主收到 httpRequest 却永不回 httpHead 时，
  // 这个条目会永久挂在 pending（res 永不 end、不发 httpCancel），而 SSE 空闲哨兵要等
  // httpHead 之后才武装，覆盖不到这一段。两条超时是接力关系。
  UPSTREAM_HEADER_TIMEOUT_MS: positiveInt('UPSTREAM_HEADER_TIMEOUT_MS', 30_000, 300_000),
  DEBUG_SSE: /^(1|true|yes)$/i.test(process.env.DEBUG_SSE || ''),
};
