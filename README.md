# DSH Relay（dsh-mobile-server）

**手机上访问你电脑上的 DSH。** 宿主端（跑在你电脑上的
[dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)）主动向本服务建立一条出站
WSS 隧道；手机上的 HTTP / SSE / WebSocket 请求原样送进那条隧道，宿主的响应原样送回手机。

**你的电脑因此不需要公网 IP，也不用做端口映射**——是它主动连出去的。

## 一键部署

两种方式，任选其一——对外行为一样，手机 App 只认「地址 + 隧道」，不认你在哪部署的。

### 方式一：Cloudflare Workers（不用自己的服务器）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WNLUO/dsh-mobile-server)

点一下按钮 → 登录 Cloudflare → 点「部署」。**构建命令留空就行**，不用填任何东西：
仓库里已经放好了编译好的产物（`dist/`），Cloudflare 拿到的就是能直接跑的东西。

部署完会给你一个 `https://<名字>.<账号>.workers.dev` 地址。不需要配任何密钥，也不用管证书。

免费额度对这个用途是够的（主要是 Durable Object 的请求数与时长）。要绑自己的域名，
在 Cloudflare 的 Workers 面板里加 Custom Domain 就行。

> **改了 Rust 代码之后**要重新出产物，否则部署的还是旧的：
> ```sh
> cd server/relay-worker/rust
> worker-build --release --no-panic-recovery
> cp build/worker/shim.mjs build/worker/index.wasm ../../../dist/
> ```
> 没有 `worker-build` 就先 `cargo install worker-build`。产物一共 430KB 左右。

### 方式二：自己的服务器

一台 Linux（装好 systemd），跑一次：

```sh
git clone https://github.com/WNLUO/dsh-mobile-server.git
cd dsh-mobile-server
sudo ./server/relay/rust/deploy/install.sh
```

机器上没有 git 的话，下载 zip 也一样（右上角 **Code → Download ZIP**，或者
`curl -L https://github.com/WNLUO/dsh-mobile-server/archive/refs/heads/main.tar.gz | tar xz`）。

脚本做四件事：装 Rust（走国内镜像）、编译、把二进制放到 `/opt/dsh-relay/`、写 systemd
服务并启动（监听 `127.0.0.1:18788`）。

跑完它会打印一段 nginx 反代配置。**把域名的 443 反代到 `127.0.0.1:18788` 就完事了**，
然后 `curl https://你的域名/healthz` 应当回 `ok`（App 走公网只认 https/wss，证书是必须的）。

它刻意不碰你的 nginx、不配 TLS、不开运营台、不开自动更新——上证书的方式太多，脚本猜一种
就会把别人的机器配歪；其余几样是要额外配置和密钥的东西，见下面的文档。

## 能做什么

- **多台电脑同时在线。** 每台宿主用自己上报的实例 id 占一条隧道，手机请求按它带来的
  实例标识分发到对应那台。同一条重连只顶掉自己那条，别人的完全不受影响。
- **找不到就拒绝。** 请求指向的实例不在线时回 503，**绝不退回到「随便挑一条」**——
  公用中转上随便挑等于把 A 家的请求送进 B 家的电脑。
- **纯转发。** 不解释业务、不缓存、不存镜像；除逐跳头与 `host` 之外请求头与响应头原样带过去。
- **可选的准入**（仅服务器版）。默认不判。打开运营台并切到「限制」之后，宿主连隧道必须带
  有效激活码，在握手阶段就拒（回 401，连 ws 都不建立）。Workers 版是纯转发，没有运营台。

自己认领的路径只有 `/healthz`、`/api/mobile/v1/health`（地址体检）与 `/status`
（在线状态）；服务器版打开运营台后再加 `/api/platform/v1/**`、`/platform/**`，以及给宿主
救急用的 `/api/desktop-plugins/ota/*`。其余全部转发。

## 这个和 FRP 差在哪

中转本身等价于「带 HTTP/WS 语义的 FRP」。差别只有一条：**手机直接用 DSH 的移动端协议
访问同一个域名**，不用多加一个端口，也不用在手机上装额外的客户端。

## 目录

```
wrangler.toml            Cloudflare 一键部署的入口（按钮要求它必须在仓库根目录）
server/
  relay/rust/            中转本体：服务器版（Rust，编出单个二进制 dsh-relay）
  relay-worker/rust/     Workers 版（Rust/WASM，跑在 Cloudflare 上）
  relay-core/            隧道协议的类型表与编解码，两份实现共用
```

两份实现都通过相对路径引用 `server/relay-core/rust`，**要在各自的目录里编译**，
别单独把那一层拷走。

- [`server/relay/rust/README.md`](server/relay/rust/README.md) — 服务器版完整文档：环境变量、
  运营台、主控端 / 被控端、插件 OTA、自动更新、日志与备份
- [`server/relay-core/PROTOCOL.md`](server/relay-core/PROTOCOL.md) — 隧道协议（帧格式、
  握手、准入、心跳）

**Workers 版没有自动更新**，也不需要：它在 Cloudflare 的托管沙箱里跑，没有文件系统、
没有常驻进程，换代就是重新部署一次。

## 客户端

手机 App 与桌面插件不在本仓库：

- 桌面插件（宿主端）：<https://github.com/WNLUO/dsh-mobile-plugin>
- 手机 App：见插件仓库的 Releases

中转对 App 是透明的——App 只认「地址 + 隧道」，不关心中转怎么写、在哪部署。

## 许可

MIT，见 [LICENSE](LICENSE)。
