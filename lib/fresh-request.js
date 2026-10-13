'use strict'

// 「读己所写」(read-your-writes) 标记在**中转侧**的副本。
//
// 副本而非共享包：插件包与中转服务器是两个独立部署单元（插件会被拷到 ~/.dsh/plugins/，
// 中转是独立进程），不能跨目录 require。权威实现与 plugin 侧
// `lib/shared/fresh-request.js` 手工同步，由
// `dsh-mobile-plugin/test/shared-helpers-parity.test.cjs` 钉住（与 safeEqual /
// HOP_BY_HOP 同一套路）。**改一边必须改另一边。**
//
// 为什么中转也必须认这个标记：App 的下拉刷新带 `?fresh=1`，是它从「侧边栏整树消失、
// 设备仍显示在线、只有下拉能救」这种被冻结/被污染的代读副本里脱身出来的唯一手段。
// 中转曾经把所有可缓存 GET（含 `?fresh=1`）都交给 `proxyCached`，镜像分支又只看
// `inst.mirror`、与查询串无关，于是空镜像会连下拉刷新一起顶掉——恢复手段被堵死。
// 现在带 fresh 的读既不读镜像也不读响应缓存，直接回源桌面。

const FRESH_QUERY_RE = /(?:^|[?&])fresh=1(?:&|$)/

/** 判断一次请求（完整 url 或 path，可带 query）是否要求「必须读出最新状态」。 */
function isFreshRequest(target) {
  return FRESH_QUERY_RE.test(String(target || ''))
}

module.exports = { FRESH_QUERY_RE, isFreshRequest }
