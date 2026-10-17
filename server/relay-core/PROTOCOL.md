# DSH 隧道协议 v2

远程操控链路：`手机 → 中转服务器 → 宿主隧道 → 本地 dsh web`。

```
┌──────────────┐  HTTPS/WSS   ┌──────────────────┐   出站 WSS(v2)  ┌──────────────┐
│  手机 App     │ ←──────────→ │  中转服务器(Node)  │ ←───────────── │  宿主         │
│ RN + WebView  │              │  · 配对鉴权(签名cookie)│  · 隧道注册  │  dsh web 插件 │
│  加载 GUI     │              │  · HTTP/WS 转发     │              │  127.0.0.1   │
└──────────────┘              └──────────────────┘              └──────────────┘
```

## v2 相对 v1 的变更（无兼容窗口，v1 直接废弃）

1. **二进制帧取代 JSON/base64 文本帧**：数据通道（请求/响应 body、WS 帧）
   传原始字节，不再 base64（消除 ~33% 体积膨胀与逐帧 JSON 解析）。
2. **请求 body 流式转发**：`httpRequest` 只带头部，body 以 `httpBody` 帧
   流式发送（空 payload 表示结束），relay 不再整包缓冲。
3. **应用层 ping/pong 心跳**：隧道双方定期互发，NAT/代理环境比 WS 原生
   ping 更可靠；超时视为死链断开。
4. **register 顶替认证**：顶替已注册实例必须携带与现注册一致的配对码
   （防劫持）；配对码更新走 `updatePairing` 消息（旧码即刻失效）。
5. **废除 OPEN 模式**：所有访问必须经过配对。

## 帧格式

每条隧道消息 = 一个 WS binary 帧（连接协商 `permessage-deflate` 压缩）：

```
[type: 1B][id: 4B 大端][length: 4B 大端][payload: length B]
```

| type | 名称 | id | payload | 方向 | 说明 |
|---|---|---|---|---|---|
| 0x01 | register | 0 | JSON `{instanceId, pairingCode, name, secret?, lanUrls?, lanCandidates?}` | 宿主→中转 | 注册/顶替实例（首条消息必须为此）。`secret` 仅在中转设了 `TUNNEL_REGISTER_SECRET` 时必填，为空或不匹配则 `close(1008)`；中转另有 `instances.json` 白名单时 `instanceId` 还必须在名单内。`lanUrls` / `lanCandidates` 是给手机的局域网直连候选（仅元数据） |
| 0x02 | registered | 0 | 空 | 中转→宿主 | 注册成功回执 |
| 0x03 | updatePairing | 0 | JSON `{pairingCode}` | 宿主→中转 | 配对码更新，旧码即刻失效 |
| 0x04 | httpRequest | N | JSON `{method, path, headers}` | 中转→宿主 | 手机 HTTP 请求头；body 随后流式 |
| 0x05 | httpBody | N | raw bytes | 双向 | 请求 body 分块；**空 payload = body 结束** |
| 0x06 | httpHead | N | JSON `{status, headers}` | 宿主→中转 | 响应头；必须先于 httpChunk |
| 0x07 | httpChunk | N | raw bytes | 宿主→中转 | 响应体分块（SSE 等） |
| 0x08 | httpEnd | N | 空 | 宿主→中转 | 响应结束 |
| 0x09 | httpError | N | JSON `{message}` | 宿主→中转 | 上游失败（→ 手机 502 / WS 1011） |
| 0x0A | wsUpgrade | N | JSON `{path, headers}` | 中转→宿主 | 手机 WS 升级请求 |
| 0x0B | wsOpen | N | 空 | 宿主→中转 | 上游 WS 已建立 |
| 0x0C | wsError | N | JSON `{message}` | 宿主→中转 | 上游 WS 建立失败 |
| 0x0D | wsText | N | raw bytes | 双向 | 上游 WS 文本帧数据 |
| 0x0E | wsBinary | N | raw bytes | 双向 | 上游 WS 二进制帧数据 |
| 0x0F | wsClose | N | 2B 大端 code + 可选 UTF-8 reason（最多 123B） | 双向 | WS 关闭（合法 code 原样透传；旧端只读前 2B） |
| 0x10 | ping | 0 | 空 | 双向 | 应用层心跳 |
| 0x11 | pong | 0 | 空 | 双向 | 心跳应答 |
| 0x12 | pairRequest | 0 | JSON `{requestId, device:{id?, deviceId?, name?, platform?, osVersion?, appVersion?, ip?}}` | 中转→宿主 | 手机发起配对，请求宿主授权；`ip` 由中转注入（手机自报的不可信） |
| 0x13 | pairConfirm | 0 | JSON `{requestId, approved, token?}` | 宿主→中转 | 授权结果；`approved` 时中转签发配对 cookie 与设备凭据并回给手机 |
| 0x14 | httpCancel | N | 空 | 中转→宿主 | 取消上游 HTTP 请求/响应 |
| 0x15 | httpPause | N | 空 | 中转→宿主 | 暂停向中转发送响应数据 |
| 0x16 | httpResume | N | 空 | 中转→宿主 | 恢复向中转发送响应数据 |
| 0x17 | sync | 0 | JSON `{kind, ...}` | 宿主→中转 | 宿主主动推送增量，用于刷新移动端镜像缓存 |
| 0x18 | revokeAll | 0 | JSON `{at}` | 宿主→中转 | 请求清空本实例全部设备授权 |
| 0x19 | revokeAllAck | 0 | JSON `{ok, revoked}` | 中转→宿主 | 清空完成回执 |

约定：id 为实例内自增整数；控制消息 payload 为 UTF-8 JSON；心跳超时
（relay 侧 60s 未收到 pong）即终止隧道，宿主自动重连。

## 设计决策

- **手机以根路径访问**：配对成功后手机加载 `https://<relay>/`，中转凭签名 cookie
  解析出 instanceId 并路由到对应隧道。GUI 的绝对路径 / WebSocket 全部原样可用，
  无需路径改写，也无需泛域名。
- **宿主端出站连接**：不需要公网 IP / 端口映射。
- **配对码 + 宿主端授权策略**：配对码由宿主生成、relay 校验（恒定时间比较 +
  失败锁定）；校验通过后询问宿主，由 `pairingPolicy` 决策——`code` 凭码放行
  （默认）、`deny` 拒绝一切新配对，sidecar 只接受显式 true。原来的桌面端弹窗
  确认随桌面端一并删除，策略实现见
  `dsh-mobile-plugin/lib/relay/pairing-policy.js`。注册顶替需配对码一致，
  防止隧道劫持。
- **中转账本模型**：中转进程能看到明文（与 frp/ngrok 同模型）；配对 cookie
  由 `RELAY_SECRET` HMAC 签名，relay 重启后密钥须保持不变。

## 手机侧 HTTP 接口

| 路由 | 说明 |
|---|---|
| `GET /` | API-only：始终 `404 {"ok":false,"error":"API endpoint not found"}` |
| `POST /pair` `{instanceId?, code, device?}` | 校验配对码 → 请求桌面端弹窗授权 → `200` 下发 `dsh_pair` cookie + 设备凭据 + **`instanceId`**。`instanceId` **可以不带**（手机手输地址 + 配对码时手上没有）：这时按 `code` 在在线实例里找那台机器，找到唯一一台才继续；一台都对不上 `404`，撞码（多台同码）`409` |
| `POST /r/<instanceId>/pair` `{code, device?}` | 同上但 instanceId 来自路径 |
| `GET /healthz` | 健康检查 |
| `GET /api/mobile/v1/connection-info` | 需设备凭据 + Bearer，回实例名与局域网候选 |
| 其他 `/api/mobile/*` | 需 `X-Dsh-Instance` + Bearer（或设备凭据），代理到实例隧道 |
| 其他任意路径（含 `Upgrade: websocket`） | `404` JSON；WebSocket 需 `/tunnel` 或设备凭据 |

移动 App 请求 `/api/mobile/*` 时同时携带 `X-Dsh-Instance`。relay 优先按该请求头选择隧道，Cookie 仅作兼容回退；宿主仍以 Bearer token 校验请求归属。这样可避免 Android 在同一 relay 域名下保存多个配对时的全局 Cookie 互相覆盖。

鉴权分层（relay 只做路由，授权边界在桌面端）：

- 带 `X-Dsh-Device-Credential`（relay 配对时签发）→ relay 本地校验凭据是否有效/未吊销；失效即 `401`。
- 仅带 `Authorization: Bearer`（局域网配对的会话）→ relay 无法校验，直接转发给桌面端裁决；**不得**读取 relay 镜像/响应缓存。

为兼容设备级事件入口，relay 另提供 `GET /api/mobile/v1/events/stream`，`sessionId` 查询参数可选。该路由在同样的设备凭据 + Bearer 鉴权后，转发到宿主插件实际支持的同路径 `/api/mobile/v1/events/stream`；如携带 `sessionId` 则原样转发过滤条件，并沿用 v2 HTTP/SSE 分块转发。未携带 `sessionId` 时转发设备级 mux 事件（包括 session/projection），不会伪造或合并事件。旧的 `/api/mobile/v1/session/stream?sessionId=<id>` 行为不变。工作区没有独立的实时事件通道，客户端以 `/api/mobile/v1/workspaces` 作为权威快照，在首次连接、回到前台、操作成功或 SSE 重连时补偿刷新。

### 配对 cookie

```
dsh_pair = <instanceId>.<base64url(deviceId)>.<expiryUnix>.<hmac_sha256(instanceId.deviceId.expiry, RELAY_SECRET)>
```

cookie 只携带 deviceId（不携带设备凭据密文）；`pairedInstance` 校验签名后还要向凭据库确认该设备凭据仍然有效，
因此 `revoke-all`（或单设备吊销）会立刻让 cookie 失效，而不必等 30 天 TTL 到期。旧的两段式 cookie 不再被接受，需重新配对。

HttpOnly / SameSite=Lax / Path=/；TLS 场景（X-Forwarded-Proto=https）追加 Secure。
relay 重启后 `RELAY_SECRET` 需保持不变（环境变量），否则已配对手机需重新配对。

### 配对码限流

同一 instanceId + IP 连续失败 5 次后锁定 60 秒，防暴力猜测。请求**不带 instanceId** 时
（按配对码找机器那条路）这时还归不到某个实例头上，先按 IP 记（同一个 `*` 桶）。

## 第一方 Desktop 插件 OTA API

第一方插件 OTA（中转侧的存储与端点）**2026-10 已删除**：插件改从 npm 分发，更新由 DSH 的
插件市场负责，中转不再是插件的分发源。从前这一节写的是 `/api/desktop-plugins/*` 的
check / versions / releases / installer.mjs / telemetry 与发布控制端点，它们现在一律不可用。

与本文件相关的是：**App 的 OTA 不走这条路**（那是另一套分发平台的 `/api/sdk/check-ota-update`），
隧道与配对帧表完全没变。剩下的 `/api/desktop-plugins/control/*` 只有运维排障（device-stats /
diagnostics / request-trace / mirror），细节见 README。

## 实现文件

- `lib/protocol.js` — 帧编解码（唯一事实源）
- [`dsh-mobile-plugin/lib/relay/protocol.js`](https://github.com/WNLUO/dsh-mobile-plugin/blob/main/lib/relay/protocol.js) — 同一份代码的自包含副本（插件包不能跨目录引用本仓库文件，需手工同步，唯一允许的差异是顶部路径注释）
- `server.js` — 中转服务端（隧道/HTTP/WS/配对）
- [`dsh-mobile-plugin/lib/relay/tunnel.js`](https://github.com/WNLUO/dsh-mobile-plugin/blob/main/lib/relay/tunnel.js) — 宿主端出站隧道客户端
- `test/fake-desktop.js` — 参考隧道实现（测试用）
