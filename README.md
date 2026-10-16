# DSH Relay（dsh-mobile-server）

中转服务。**它自身不是模型宿主**：宿主插件（[dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)，运行在无头
Cordis Host 中）主动向本服务建立出站 WSS 隧道，手机的 HTTPS/WSS 请求经本服务转发
进隧道，再由宿主插件转给它本机的 `dsh web`。因此本服务无需入站可达主机的网络。

隧道帧格式、配对与鉴权细节见 [`PROTOCOL.md`](./PROTOCOL.md)。

## Cloudflare Workers 一键部署（个人自建）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WNLUO/dsh-cloudflare-relay)

Cloudflare Workers 版的唯一维护源是独立公开仓库：[WNLUO/dsh-cloudflare-relay](https://github.com/WNLUO/dsh-cloudflare-relay)。点击按钮后登录 Cloudflare 并授权 GitHub，Cloudflare 会把该仓库复制到你的账号，自动创建 Worker 和 Durable Object，并提供 `workers.dev` 地址；不需要自有域名、备案或服务器。旧 `cloudflare/` 路径暂作旧版插件一键部署入口的兼容副本，后续维护以独立仓库为准。

部署时设置 `RELAY_SECRET`（随机生成，至少 32 个字符）。公开使用建议同时设置 `TUNNEL_REGISTER_SECRET`，并在 DSH 桌面端中转设置里填入相同密钥。部署后把 Worker 地址配置到桌面端，再通过桌面端的配对码或二维码连接手机。部署与自动更新说明见 [Cloudflare Relay README](https://github.com/WNLUO/dsh-cloudflare-relay#readme)。

该版本面向个人自用；Cloudflare 生命周期或部署更新可能断开长连接，进行中的请求会失败，不应作为多人共享中转服务。用户仓库会每日检查独立 Cloudflare Relay 仓库的稳定版，先通过测试和 Wrangler dry-run 再提交更新，由 Cloudflare Builds 自动部署；可在 GitHub Actions 暂停，也可撤销更新提交回退代码。更新会保留自己的 Worker 配置和 Cloudflare 密钥，Durable Object 数据迁移不能随代码回退。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8700` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_SECRET` | `''` | 配对 cookie HMAC 密钥。**必填**，建议 `openssl rand -hex 32` |
| `PAIR_TTL_SEC` | `2592000`（30 天） | 配对 cookie 有效期 |
| `PLUGIN_CONTROL_TOKEN` | `''` | 插件 OTA 发布及运维控制面的 Bearer token；为空则控制面拒绝 |
| `PLUGIN_OTA_ROOT` | `<包目录>/plugin-ota` | 运维与插件 OTA 数据根目录：诊断快照、请求轨迹，以及 `releases.json` 和完整 tgz |
| `PLUGIN_PUBLIC_BASE_URL` | `''` | 插件 OTA 包下载公开基址；为空时根据请求 Host 与转发协议生成（nginx `/` 转发可用） |
| `RELAY_CACHE_TTL_MS` | `30000` | 移动端镜像缓存的新鲜期 |
| `MIRROR_DATA_DIR` | `<包目录>/data` | 移动端镜像缓存数据目录 |
| `DEVICE_CREDENTIALS_FILE` | `$DSH_HOME/relay-device-credentials.json` | 设备凭证落盘位置 |
| `DIAGNOSTICS_FILE` | `$PLUGIN_OTA_ROOT/diagnostics.json` | 诊断快照落盘位置 |
| `REQUEST_TRACE_FILE` | `$PLUGIN_OTA_ROOT/request-trace.json` | 请求追踪落盘位置 |
| `TUNNEL_REGISTER_SECRET` | `''` | 隧道注册共享密钥；非空则注册帧必须带匹配的 `secret`，否则 `close(1008)` |
| `TUNNEL_INSTANCES_FILE` | `<包目录>/instances.json` | 允许注册的 instanceId 白名单（JSON）。**文件不存在 = 不限制；存在但内容不合法 = 启动即失败** |
| `DEBUG_SSE` | 未设置 | 设为 `1/true/yes` 打开 SSE 调试日志 |
| `NODE_ENV` | 未设置 | 设为 `production` 时**强制要求 `RELAY_SECRET` 至少 32 字符**，否则启动即抛错 |

## 部署

需要 Node ≥ 20（`engines` 声明），唯一运行时依赖是 `ws`。

```sh
npm install --omit=dev
RELAY_SECRET=$(openssl rand -hex 32) NODE_ENV=production node server.js
curl http://127.0.0.1:8700/healthz     # → ok
```

- **`RELAY_SECRET` 必填。** 设为 `NODE_ENV=production` 时会强制校验其长度 ≥ 32 字符，不满足直接抛错退出；用 `openssl rand -hex 32` 生成，换掉它等于让所有已配对设备失效。
- **手机走公网必须 HTTPS/WSS。** 本服务自身只提供明文 HTTP/WS，`HOST` 默认 `0.0.0.0`，上线时应置于带有效证书的反向代理（nginx/Caddy）之后，并由代理转发 WebSocket 升级。
- 端口 `8700` 与运维数据目录（`PLUGIN_OTA_ROOT`）、镜像缓存目录（`MIRROR_DATA_DIR`）需要可写。
- **隧道注册默认是开放的。** 配对码只在「已注册实例之间」比对，首次注册没有任何认证，所以没配准入时任何人都能抢注一个还没被占的 `instanceId`，把真宿主顶成 `bad pairing code`。共享部署至少配一种：宿主侧在插件的「注册密钥」设置里填一个与本服务 `TUNNEL_REGISTER_SECRET` 相同的值（桌面 DSH 从图标启动、拿不到 shell 环境变量，所以密钥只走设置，不读 `DSH_RELAY_REGISTER_SECRET`），或把 `instanceId` 写进 `instances.json`（见 `instances.example.json`）。白名单由服务器管理员维护，桌面端与手机都不需要改配置。

交给 systemd：

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH Mobile relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-mobile/dsh-mobile-server
Environment=NODE_ENV=production
Environment=PORT=8700
Environment=RELAY_SECRET=<openssl rand -hex 32 生成>
Environment=PLUGIN_CONTROL_TOKEN=<发布插件 OTA 时才需要>
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now dsh-relay
```

> `PLUGIN_CONTROL_TOKEN` 为空时，`/api/desktop-plugins/control/*` 整个控制面都会拒绝（401）。
> 插件 OTA 只负责独立的设备更新链；npm 仍是正式分发源，App OTA 不在本服务。

## 端点

### 隧道与配对

- `GET /healthz` —— 健康检查。
- `POST /pair` 或 `POST /r/<instanceId>/pair` —— 手机提交配对码；中转校验后经隧道
  由宿主端按 `pairingPolicy` 决策，通过才签发配对 cookie `dsh_pair`。非 POST 一律 405。
- 隧道 WebSocket 升级 —— 宿主端出站连接，帧格式见 `PROTOCOL.md`。

### 移动 API 网关

`/api/mobile/v1/*` 由中转校验配对 cookie 后透传到隧道里的宿主插件，**中转不解释
业务语义**。除下面几个中转自己处理的端点外，其余全部转发：

- `GET /api/mobile/v1/connection-info` —— 由中转自答的连接元数据（`lanUrls`、
  `lanCandidates`、镜像时间等），**不经隧道转发**。
- `GET /api/mobile/v1/status` —— 转发给宿主插件；中转只是在上游判定前强制校验
  Bearer 形态，隧道实例不在线时返回 401。
- `GET /api/mobile/v1/events/stream` —— SSE 事件流。
- `POST /api/mobile/v1/diagnostics` —— 移动端诊断**上报**（设备快照 + 最近条目），
  按桌面 instanceId 落盘供控制面 `/api/desktop-plugins/control/diagnostics` 读取。
  用设备凭证鉴权，且刻意不要求实例隧道在线 —— 手机正是在连不上桌面时才会来上报。
- `POST /api/mobile/v1/device-credential/revoke` —— 吊销当前设备凭证（凭证经
  `X-Dsh-Device-Credential` 头或 Bearer 传入）。

「吊销本实例全部设备」不是 HTTP 路由，而是宿主 → 中转的隧道消息
`revokeAll (0x18)` / `revokeAllAck (0x19)`。

### 插件 OTA（npm 分发之外的设备更新链）

npm 是插件正式分发源；OTA 服务只发布完整 npm tgz，供设备检查与下载，不参与 App OTA。
公开接口只提供 stable：

- `GET /api/desktop-plugins/ota/latest?platform=<process.platform>&channel=stable` 返回 `{ok:true,data:{version,platform,channel,packageUrl}}`。
- `GET /api/desktop-plugins/ota/releases/<version>/package.tgz?platform=<process.platform>` 流式下载该平台版本包。
- `PUT /api/desktop-plugins/control/ota/releases/<version>/package.tgz?platform=<process.platform>&channel=stable` 发布原始 gzip npm tarball；仅接受 `Authorization: Bearer <PLUGIN_CONTROL_TOKEN>`，并校验包内 `package/package.json` 的名称为 `dsh-mobile-plugin`、版本与 URL 一致。请求上限 128 MiB。

索引写入 `PLUGIN_OTA_ROOT/releases.json`（platform→version），包体写入 `PLUGIN_OTA_ROOT/releases/<platform>/<version>.tgz`。latest 从该平台 stable 版本按 SemVer 推导。配置了 `PLUGIN_PUBLIC_BASE_URL` 时包地址使用该基址；否则按请求 Host 与 `X-Forwarded-Proto` 生成，nginx 根路径转发无需额外前缀。

发布示例（在插件仓库根目录执行；需已安装依赖）：

```sh
VERSION=$(node -p "require('./package.json').version")
PLATFORM=$(node -p "process.platform")
npm pack --pack-destination /tmp
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $PLUGIN_CONTROL_TOKEN" \
  -H 'Content-Type: application/gzip' \
  --data-binary "@/tmp/dsh-mobile-plugin-$VERSION.tgz" \
  "https://dsh-hub.wnluo.com/api/desktop-plugins/control/ota/releases/$VERSION/package.tgz?platform=$PLATFORM&channel=stable"
```

`PLATFORM` 必须与设备上的 Node `process.platform` 相同；macOS 返回 `darwin`。发布前先确认 `PLUGIN_CONTROL_TOKEN` 已在当前 shell 设置。**App 的 OTA 不受影响**：它使用 `app.wnluo.com` 的独立分发 API。

### 桌面插件的运维观测（还在）

`/api/desktop-plugins/control/*` 这个前缀留着，因为里面有几件与插件 OTA 无关的排障动作，
全部要 `Authorization: Bearer <PLUGIN_CONTROL_TOKEN>`：

- `GET /api/desktop-plugins/control/device-stats` —— 在线桌面实例、已配对手机数（设备与配对维度）。
- `GET /api/desktop-plugins/control/diagnostics[?instance_id=]` —— 宿主上报的诊断快照。
- `GET /api/desktop-plugins/control/request-trace[?instance_id=]` —— HTTP 请求轨迹。
- `GET /api/desktop-plugins/control/mirror[?instance_id=]` —— 各实例的镜像快照摘要。

诊断与请求轨迹落盘在 `PLUGIN_OTA_ROOT`（`diagnostics.json` / `request-trace.json`，
都走临时文件 + `rename` 原子替换）。目录名沿用历史名，别再按字面理解成「插件 OTA 物料」。

`PLUGIN_CONTROL_TOKEN` 只存在于服务端环境变量，不写入日志或响应。

## 测试

```sh
npm test                  # 全量：包含 OTA API 与 relay 回归
npm run test:ota-api       # 发布鉴权、tarball 校验、latest 与下载
npm run test:integration  # test/integration-tunnel.js（手机 → relay → 真实隧道 → 假上游）
npm run test:auth-contract # test/relay-auth-contract.js（鉴权契约 / 吊销立即生效）
```

各文件职责：

- `test/smoke.js` —— 协议编解码、注册、配对、限流、静态检查。
- `test/plugin-ota.js` —— OTA manifest 校验与版本比较。
- `test/integration-tunnel.js` —— 用桌面插件真实的 `lib/tunnel.js` 跑全链路代理、SSE、WS、大请求体。
- `test/cache-while-revalidate.js` —— 响应缓存与桌面镜像（sessions/workspaces/messages/stats/models）。
- `test/credentials-revoke-all.test.cjs` —— 设备凭据的批量吊销。
- `test/relay-auth-contract.js` —— 鉴权边界：局域网配对（仅 Bearer）必须可路由、设备凭据吊销后必须 401 且不回落 Bearer、桌面离线时诊断与监控仍可用。
