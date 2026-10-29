# AGENTS.md — dsh-mobile-server 开发入口

> 由工作区上下文加载器**每个会话自动注入**：只写「必须做什么」。
> **为什么**、实测量与坑都在 [`docs/dev-map.md`](docs/dev-map.md)，按需读取。

这个仓库是 DSH Mobile 的 **Rust 中转**（`server/relay/rust` → 二进制 `dsh-relay`，纯转发隧道）与
**隧道协议类型表**（`server/relay-core`）。App 那边（`dsh-mobile-plugin` / `app`）不在这个仓库，
它的地图在 DSH-mobile 主仓的 `docs/dev-map.md`。

## 0. 接到需求后的固定动作

1. **先查地图，不扫树**：`grep -n '<关键词>' docs/dev-map.md`，命中后只读那一条，别整读。
2. **动手深读前先立计划**：改哪些文件、跑哪些测试。
3. **写代码前先抄同类现有写法**：Rust 侧照 `src/` 里已有的模块结构，别臆造类型。
4. **定位失败就回写地图**：新条目补进 `docs/.dev-map-parts/*.md`，然后 `npm run map`。
   A 段是生成物，别手改。
5. **改完跑测试**：`npm test`（= relay-core + relay 两套 cargo test）。
6. **可以提交，不许推**：按 Conventional Commits。什么时候发由用户定。

## 1. 硬约束

- **协议两侧对齐**：`relay-core/protocol-types.js` 是帧类型的**事实源**，Rust 侧
  `relay-core/rust/src/lib.rs` 与 `relay/rust/src/proxy.rs` 跟它逐条对齐。加/改帧类型要三处一起动，
  并同步 `relay-core/PROTOCOL.md` 的帧表。
- **不引 HTTP 框架**：中转手写 HTTP/1.1 解析是刻意设计，理由见地图 A1 段「中转 Rust 实现」。
- **发布只发 musl 静态包**：glibc 动态包在 Alpine 上跑不了。发版流程、四台机器的现状、日志轮转
  与自更新源的坑，全在地图 A1 段的运维条目里，动手前先读那几条。
- **换二进制必须先 stop 再 mv**：运行中 `cp` 覆盖会撞 `Text file busy`。
- `target/` 不要进命令的扫描范围（4G，`grep -r` 会挂）；用 `rg` 并排除它。

## 2. 常用命令

```sh
npm test                       # relay-core + relay 两套 cargo test
npm run build:relay            # release 二进制 + 控制台
npm run test:e2e               # 三套 e2e（要现成的 release 二进制）
npm run map                    # 再生 docs/dev-map.md
npm run map:check              # 校验地图没过期
npm run affected -- --files <改过的文件>   # 反查命中的条目与测试
```
