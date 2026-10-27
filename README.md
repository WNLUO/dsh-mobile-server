<h3 align="center">DSH Mobile Server</h3>

<p align="center">
  <img src="assets/banner.jpg" alt="AI-HUB：手机和平板上的 DSH 会话界面" width="760">
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
</p>

<p align="center">让手机连回你家里那台电脑。</p>

**中转服务器。** 手机和电脑之间隔着公网，这里是它们的落脚点：转发 HTTP、SSE 与 WebSocket，桌面插件从内网主动建一条出站 WSS 隧道上来。用户的电脑因此不需要公网 IP，也不用在路由器上开端口。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/main/assets/connection-dark.svg">
    <img src="https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/main/assets/connection-light.svg" alt="手机 App 经中转或局域网连到你电脑上的 DSH" width="720">
  </picture>
</p>

图上中间那台就是你部署的这个服务。它只把连接对上、把帧转过去：模型怎么选、文件放哪、会话记录存哪儿，都在用户自己那台电脑上。

## 功能

### 转发

- HTTP、SSE、WebSocket 三条都转，帧级透传 —— 手机上的进度条就是电脑那边的进度。
- 隧道由电脑这边主动出站建立，双向流量都走这一条连接，内网机器因此能被公网够到。
- 移动端列表用的镜像快照在隧道抖动时兜一下，不至于一断就空白。

### 可选能力

- **中转控制台**：微信登录、激活码、准入模式、主控端与被控端 —— 和转发在同一个二进制里，不用另起一套服务。
- **iOS 离线推送**：配好 APNs 密钥，手机锁屏也能收到提醒；不配就完全关着。
- **紧急完整包**：插件的 OTA 物料也放在这里下发。

### 运维

- `/healthz` 健康检查，前面挂反代就能接监控。
- 日志轮转模板在部署目录里，路径按你的机器改。

## 部署

在 Linux 服务器上运行：

```sh
git clone https://github.com/WNLUO/dsh-mobile-server.git
cd dsh-mobile-server/server/relay/rust
sudo ./deploy/install.sh
```

安装脚本会安装 Rust、编译 `dsh-relay` 并配置 systemd 服务。服务默认监听 `127.0.0.1:18788`，应在前面配置 HTTPS/WSS 反向代理，Caddy 或 Nginx 都可以，证书走 Let's Encrypt 一类的自动签发。

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

## 为什么做这个

DSH 跑在家里的电脑上，人出门在外，手机要连回来。麻烦在两头都够不着对方：绝大多数家庭宽带没有公网地址，路由上开端口既不现实也不安全，而手机在外面也没有别的办法找到你那台机器。

所以需要一台有公网地址的机器当落脚点，手机和电脑各自连上它，由它把两边对上。这个中转就是那个落脚点，它做的事刻意压得很窄 —— 对上连接、转发帧，剩下的都留在用户自己那台电脑上。

## 和别的方案比

**现成的内网穿透（frp、ngrok 一类）**：网络能打通，但你要自己维护一套配置，而且它们不认识 App 和插件之间的协议 —— 配对、二维码、设备凭据这些还得另想办法。

**直连 VPN（Tailscale、WireGuard）**：网络层能通，代价是手机上常开 VPN，而且只在你自己的设备之间有效，别人装上 App 也连不到你这台。

**直接把端口暴露到公网**：要公网 IP、要 DDNS、要自己扛 TLS，家用宽带大多拿不到固定地址，安全面也全靠自己盯。

## 配套的客户端

桌面插件与手机 App 都在 <https://github.com/WNLUO/dsh-mobile-plugin>，App 的下载入口和配对步骤见那边的 README。

## 交流与反馈

<p align="center">
  <img src="assets/wechat-group.png" alt="企业微信群二维码" width="180">
</p>

扫上面的码进企业微信群。不方便的话发邮件到 <admin@wnluo.com> 或 <wnluo2@gmail.com>。用着顺手就给仓库点个 star。

## License

MIT，见 [LICENSE](LICENSE)。
