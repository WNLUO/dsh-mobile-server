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
