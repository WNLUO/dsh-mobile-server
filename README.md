# DSH Mobile Server

Rust 中转服务器，为手机 App 与桌面插件提供 HTTP、SSE、WebSocket 转发。桌面插件主动建立出站 WSS 隧道，因此用户电脑不需要公网 IP 或端口映射。

## 部署

在 Linux 服务器上运行：

```sh
git clone https://github.com/WNLUO/dsh-mobile-server.git
cd dsh-mobile-server/server/relay/rust
sudo ./deploy/install.sh
```

安装脚本会安装 Rust、编译 `dsh-relay` 并配置 systemd 服务。服务默认监听 `127.0.0.1:18788`，应在前面配置 HTTPS/WSS 反向代理。`/healthz` 用于健康检查。

## 环境变量（可选能力）

纯转发部署一个环境变量都不用配。下面这些是**可选**能力的开关：

- 控制台（微信登录 / 激活码 / 准入）：`PLATFORM_ENABLED=1` 起，其余见 `console/config.rs`。
- 镜像兜底：`MIRROR_CACHE=0` 关（默认开），`MIRROR_FALLBACK_MS` 调阈值。
- **iOS 离线推送**：`APNS_KEY` + `APNS_KEY_ID` + `APNS_TEAM_ID` 三样都配才开。`APNS_KEY` 是苹果开发者后台生成的 `.p8` 私钥（Apple Push Notifications authentication key，ES256），接受 PEM 原文或文件路径（支持 `~/`）。不配就是关闭，转发与其它功能零影响，启动日志会有一条 `apns disabled`。

## 关于 iOS 离线推送的一个苹果规矩

推送能力绑在 **App 的归属**上，不绑在中转上：只有持有这个 App 包名（bundle id）的开发者团队签发的密钥，才能给这个 App 发推送。由此：

- **你用的是我们发布的 App Store 正式包**：离线推送只在你把**我们团队签发的 `.p8` 密钥**配到你的中转上时才生效。你自己的苹果账号生成的密钥签出来的推送会被苹果拒收（App 不是你的）——这不是 bug，是苹果的生态规矩，任何自建服务端推官方客户端（微信、Telegram）都是同一限制。
- **你自己改包自建**（换自己的 bundle id、用自己的账号签名）：那你的密钥对你的包整条链路都是通的，照上面一节配置即可。这条链路本来就是为这个场景修的。
- 密钥与证书无关：`.p8` 不过期（证书一年一换），一台密钥可推该团队全部 App，但**拿不到推送历史**，也无法给其它团队的 App 发。

## 开发与测试

需要 Rust 工具链和 Node.js：

```sh
npm ci
npm ci --prefix server/relay/rust/console
npm run test:relay-core
npm run test:relay
npm run build:relay
npm run test:e2e
```

- `server/relay/`：Rust 中转服务与可选管理控制台。
- `server/relay-core/`：中转与插件共用的协议类型表、Rust 编解码实现及协议说明。

帧类型表以 `server/relay-core/protocol-types.js` 为准。插件内的协议副本需与它保持一致；Rust 对撞测试使用仓库内的 JS 测试实现作为字节级参照。

## 客户端

桌面插件：<https://github.com/WNLUO/dsh-mobile-plugin>

## 许可

MIT，见 [LICENSE](LICENSE)。
