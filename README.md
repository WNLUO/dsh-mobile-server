# DSH Relay（dsh-mobile-server · 自建版）

**一个纯转发的自建中转。** 宿主端（跑在用户电脑上的
[dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)）主动向本服务建立一条出站
WSS 隧道；手机上来的 HTTP / SSE / WebSocket 原样送进那条隧道，宿主的响应原样送回手机。
因此本服务无需入站可达用户电脑的网络。

## 边界

- **一条隧道。** 同一时刻只服务一条宿主连接，新连接直接取代旧的（旧连接上没结束的请求
  会被一次性失败掉）。自建版是「一个人给自己一台电脑搭的」，不做多租户。
- **不鉴权。** 存取控制是宿主的事，中转只转发。配对、设备凭据、注册准入都不在这里。
- **不解释业务。** 不缓存、不存镜像、不认路径语义；请求头与响应头除逐跳头与 `host`
  之外一律原样带过去。

自己认领的路径只有 `/healthz` 与 `/api/mobile/v1/health`（地址体检），其余全部转发。

> 这台中转因此等价于「带 HTTP/WS 语义的 FRP」。它跟 FRP 的差别只有一条：**手机直接用
> 它自己的协议访问同一个域名**，不需要额外暴露端口、也不需要在手机上装客户端。
> 多台机器共用一台中转、设备身份与即时吊销，都不在这个版本里（那是运营版与中控端的事）。

## 三个后端版本

本仓库是**自建版**：纯转发，可以单独一台服务器跑起来。

- **运营版**（我们自己部署的那台）= 本仓库的中转核心 + 平台（登录 / 支付 / 授权码）+ 中控，
  在 [`dsh-mobile-hub`](../dsh-mobile-hub/README.md)。它**引用**本仓库的核心（`start({ modules })`），
  不拷贝核心，中转这一半一行都不用改。
- **Workers 版**在独立仓库 [`WNLUO/dsh-cloudflare-relay`](https://github.com/WNLUO/dsh-cloudflare-relay)。

## 运行

需要 Node ≥ 20，唯一运行时依赖是 `ws`。

```sh
npm install --omit=dev
PORT=8700 node server.js
curl http://127.0.0.1:8700/healthz     # → ok
```

交给 systemd：

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH Mobile relay (self-hosted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-mobile/dsh-mobile-server
Environment=PORT=8700
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- **手机走公网必须 HTTPS/WSS。** 本服务自身只提供明文 HTTP/WS，`HOST` 默认 `0.0.0.0`，
  上线时应置于带有效证书的反向代理（nginx/Caddy）之后，并由代理转发 WebSocket 升级。
- 没有任何必填的环境变量。

## 环境变量

全部可选，只影响「收多少、等多久」。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8700` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_FRAME_BYTES` | `8MiB` | 单个隧道帧上限 |
| `MAX_BODY_BYTES` | `50MiB` | 单个请求体上限，超过回 413 |
| `MAX_PENDING` | `256` | 一条隧道上同时在途的请求数 |
| `MAX_SSE_CONNECTIONS` | `16` | 同时开着的 SSE 条数，超过回 429 |
| `MAX_WS_CONNECTIONS` | `256` | 同时桥接的手机 WebSocket 条数 |
| `MAX_WS_MESSAGE_BYTES` | `8MiB` | 单条手机 WS 消息上限 |
| `MAX_WS_QUEUE_BYTES` | `16MiB` | WS 建立前允许排队的上行字节数 |
| `UPSTREAM_HEADER_TIMEOUT_MS` | `30000` | 等宿主回响应头的上限，超时回 504 |
| `TUNNEL_HEARTBEAT_MS` | `15000` | 隧道 ping 周期 |
| `TUNNEL_PONG_TIMEOUT_MS` | `60000` | 隧道多久没 pong 就认定死链 |
| `WS_HEARTBEAT_MS` | `15000` | 手机 WS ping 周期 |
| `WS_PONG_TIMEOUT_MS` | `60000` | 手机 WS 多久没活性就认定半开 |
| `DEBUG_SSE` | 未设置 | 设为 `1/true/yes` 打开 SSE 调试日志 |

数值走 `positiveInt`：越界**直接抛错退出**，不是 clamp —— 手滑写成 0 会让限额「关掉」
而不是「设错」，启动即失败才留得下现场。

## 端点

- `GET /healthz` —— 健康检查，回 `ok`。
- `GET /api/mobile/v1/health` —— 地址体检：手机在接入之前问「这个地址上是谁」。**刻意不
  鉴权**，回答只有服务名与版本（消费方 `app/src/services/viewmodels/addressProbe.ts`）。
- **其余全部转发**给隧道里的宿主；没有隧道时回 `503 {ok:false,error:"no host tunnel connected"}`。
- `WebSocket /tunnel` —— 宿主的出站隧道接入点（保留路径）。
- `WebSocket <其它路径>` —— 手机 ↔ 宿主的 WS 桥接。

## 测试

```sh
npm test                     # 全量
npm run test:integration     # 手机 → 中转 → 真隧道 → 假上游（HTTP / SSE / WS / 取代）
npm run test:headers         # 转发头规则
```

- `test/smoke.js` —— 协议编解码 + 自己认领的那两个路径 + 模块挂载。
- `test/integration-tunnel.js` —— 端到端：HTTP（请求体、自定义头）、SSE 流式、手机 WS 桥接、
  没有隧道时的失败、新连接取代旧隧道。
- `test/fake-desktop.js` —— 参考隧道实现（宿主插件的 `lib/relay/tunnel.js` 按它实现）。
- `test/superseded-tunnel.cjs` —— 单隧道语义与「断开时把在途请求一次性失败掉」。
- `test/sse-idle.cjs`、`test/sse-header-timeout.cjs` —— SSE 的两条超时（接力关系，缺一不可）。
- `test/phone-ws-heartbeat.cjs`、`test/ws-queue-flush.cjs` —— 手机 WS 的半开判定与队列冲刷。
- `test/forward-headers.test.cjs` —— 逐跳头与 `host` 必须丢掉，其余原样转发。
- `test/protocol-doc-parity.cjs` —— 帧表与 `PROTOCOL.md` 一一对应。

## 这个版本里没有的东西

2026-10-16 精简成纯转发时删掉了这些（要历史行为看 `git log` 与 `docs/decisions.md`）：

配对（配对码 / 桌面弹窗授权 / 配对 cookie）、隧道注册与实例路由、注册准入（共享密钥与
实例白名单）、设备凭据的签发与吊销、配对失败限流、响应缓存、桌面镜像、运维观测四个接口、
手机诊断上报、请求轨迹、插件 OTA 的发布与下载。

`lib/protocol.js` 仍保留全部帧定义，因为它是与插件侧**逐字节对齐**的唯一事实源
（`dsh-mobile-plugin/test/protocol-parity.test.cjs` 钉住）；中转只使用其中的
`http*` / `ws*` / `ping` / `pong`。
