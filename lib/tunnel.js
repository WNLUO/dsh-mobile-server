'use strict';

/**
 * 当前隧道（单条）。
 *
 * 自建版没有实例注册、没有多租户：同一时刻只服务**一条**宿主隧道，`current` 就是它。
 * 新连接直接取代旧的 —— 旧连接上还挂着的请求会被一次性失败掉，否则那些帧会继续被
 * 处理进一个已经没人要的隧道对象（旧连接可能还停在 OPEN，收不到 close 帧）。
 *
 * 依赖方向：叶子（只被 proxy-http / bridge-ws / tunnel-handler / server 引用）。
 */

let current = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/**
 * 一条隧道的运行时状态。
 *
 * `pending` 与 `nextId` 都挂在隧道对象自己身上：以前它们按 instanceId 存在模块级 Map
 * 里，是因为实例对象会被浅拷贝成「请求视图」交给每个请求，拷贝里的 `nextId` 永远是
 * 初值。现在没有视图这一层了，一条隧道一个对象，帧 id 只要在这条隧道内单调即可。
 */
function createTunnel(ws) {
  return {
    ws,
    pending: new Map(),
    nextId: 0,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  };
}

function getTunnel() {
  return current;
}

/** 装上一条新隧道，返回被它取代的那条（没有则 null）。 */
function setTunnel(tunnel) {
  const previous = current;
  current = tunnel;
  return previous;
}

/** 断开时清掉自己。被取代的旧隧道关闭时**不能**把新隧道一起清掉。 */
function clearTunnel(tunnel) {
  if (current !== tunnel) return false;
  current = null;
  return true;
}

module.exports = { log, createTunnel, getTunnel, setTunnel, clearTunnel };
