# relay-core — 三份后端共用的中转协议定义

这个目录只放**与运行时无关**的隧道协议数据。三个中转各有自己的入口和部署方式，但它们说的是同一种线上的字节格式，那份格式定义在这里。

```
server/
├── relay-core/            共用：帧类型表与线格式常量（本目录）
├── relay/rust/            自建版：Rust 二进制（可选带中转控制台）
├── relay-worker/rust/     Workers 版：Rust/WASM 一键部署
└── dsh-mobile-server/     Workers JS 版（旧实现，仍在服役）
```

运营版（原 `dsh-mobile-hub/`）已于 2026-10-17 并入 Rust 中转的控制台，目录删除。

## 为什么只有类型表共用，编解码不共用

协议本身是一份，但编解码函数写不成一份。Node 侧用 `Buffer`，Cloudflare Workers 运行时**没有 Buffer**，必须用 `Uint8Array` 加 `DataView`。把其中一种写法硬套到另一边，要么给用户的一键部署塞进一层 polyfill，要么让 Node 中转的性能白白受损。

所以边界是：**编号和规则共用，字节操作各写各的**。容易出错、且改一次要改三处的东西，恰恰是编号——改错一个数字的表现是帧被静默丢弃，既不报错也没有日志。这层已经收进来了。

## 谁引用它

- `server/relay/rust/` —— 按路径依赖 `relay-core/rust`（crate `dsh-relay-protocol`），不另存副本
- `server/relay-worker/rust/` —— 同样依赖 `relay-core/rust`
- `dsh-mobile-plugin/lib/relay/protocol.js` —— **自带一份内联副本**。插件是独立发布的 npm 包，不能跨目录引用本仓库，这是它必须自包含的硬约束
- `server/dsh-mobile-server/src/protocol-types.mjs` —— **自带一份副本**。它要能被 Cloudflare 一键部署直接取用，同样不能跨目录引用

副本就意味着可能漂移，所以 drift 由测试而不是由自觉来管：

- `server/relay-core/test/cross-runtime-parity.test.mjs` —— JS 实现与 Workers 实现对同一输入编码出的字节逐一对撞，并比两边的类型表
- `server/relay-core/rust/tests/parity.rs` —— Rust 实现的编解码与类型表对着 JS 权威实现逐字节比
- `dsh-mobile-plugin/test/protocol-parity.test.cjs` —— 插件副本的类型表对共用表、编解码对 JS 实现

比的是**行为**而不是源码文本：纯重构不该让测试变红，改了编号必须变红。变异验过——把 Workers 侧一个帧编号改掉，跨运行时那条立刻红并指名是哪个帧。

## Rust 实现

`rust/` 下是同一个协议的 Rust 实现（crate `dsh-relay-protocol`）。它**只做字节、不做网络**：
帧类型常量、编解码、close 载荷、UTF-8 截断。中转本身转成 Rust 是分阶段做的，目前完成的是
这一层——网络层（隧道、转发）还没翻。

正确性同样靠对撞而不是靠自觉：`rust/tests/parity.rs` 在运行时调 `node` 跑上面那份 JS 权威
实现，拿它编出的字节和 Rust 编出的逐字节比。跑法 `npm run test:relay-rust`。

## 改协议时的顺序

1. 改本目录的 `T` 表（加帧、改编号）
2. 同步 `dsh-mobile-plugin/lib/relay/protocol.js`、`dsh-mobile-server/src/protocol-types.mjs`
   与 `rust/src/lib.rs` 的 `t` 模块里内联的那几份
3. 改 `dsh-mobile-server/PROTOCOL.md` 的帧表
4. `npm run test:relay-core` + `npm run test:relay-rust` + `cd dsh-mobile-plugin && npm test` + `cd server/dsh-mobile-server/node && node test/protocol-doc-parity.cjs`

漏掉任何一步都有测试直接报出来，不会静默丢帧。
