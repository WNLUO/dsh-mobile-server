# DSH 隧道协议 v2

手机通过 HTTPS/WSS 连接 Rust 中转，宿主插件主动连 `/tunnel` 建立出站 WSS 隧道。中转只转发 HTTP、SSE、WebSocket；移动端鉴权与配对由宿主处理。中转控制台可选启用，限制模式下在隧道握手前检查激活码。

每条隧道消息是一个 WS binary 帧：

```
[type: 1B][id: 4B 大端][length: 4B 大端][payload: length B]
```

`id=0` 表示控制帧；`id=N` 对应一条请求。JSON 载荷使用 UTF-8；二进制数据原样传输。

| type | 名称 | id | 载荷 | 用途 |
|---|---|---|---|---|
| 0x01 | register | 0 | JSON `{instanceId}` | 宿主登记实例；同一实例重连只取代自己 |
| 0x02 | registered | 0 | JSON | 中转确认注册 |
| 0x03 | updatePairing | 0 | JSON | 保留编号 |
| 0x04 | httpRequest | N | JSON `{method, path, headers}` | 手机请求头送到宿主 |
| 0x05 | httpBody | N | bytes | 请求体；空载荷表示结束 |
| 0x06 | httpHead | N | JSON `{status, headers}` | 宿主响应头 |
| 0x07 | httpChunk | N | bytes | 宿主响应体（含 SSE） |
| 0x08 | httpEnd | N | 空 | 响应结束 |
| 0x09 | httpError | N | JSON `{message}` | 上游错误 |
| 0x0A | wsUpgrade | N | JSON `{path, headers}` | 手机 WS 升级请求 |
| 0x0B | wsOpen | N | 空 | 上游 WS 已连接 |
| 0x0C | wsError | N | JSON `{message}` | 上游 WS 错误 |
| 0x0D | wsText | N | bytes | WS 文本数据 |
| 0x0E | wsBinary | N | bytes | WS 二进制数据 |
| 0x0F | wsClose | N | 2B 大端 code + 可选 UTF-8 reason | WS 关闭，reason 最多 123 字节 |
| 0x10 | ping | 0 | 空 | 隧道应用层心跳 |
| 0x11 | pong | 0 | 空 | 隧道心跳应答 |
| 0x12 | pairRequest | 0 | JSON | 保留编号 |
| 0x13 | pairConfirm | 0 | JSON | 保留编号 |
| 0x14 | httpCancel | N | 空 | 取消上游 HTTP 请求 |
| 0x15 | httpPause | N | 空 | 暂停上游响应流 |
| 0x16 | httpResume | N | 空 | 恢复上游响应流 |
| 0x17 | sync | 0 | JSON | 宿主把整份镜像推给中转（会话清单 + 工作区 + 已签发设备凭据的 sha256）。转发路径不用它；中转只在宿主那条隧道不在时拿它兜底，`MIRROR_CACHE=0` 时收到就丢 |
| 0x18 | revokeAll | 0 | JSON | 保留编号 |
| 0x19 | revokeAllAck | 0 | JSON | 保留编号 |
| 0x1A | pushRegister | 0 | JSON | 宿主代 App 上报/删除 iOS 推送令牌（{deviceId, platform, token} 或 {deviceId, action:'delete'}）；中转按实例落表，控制台未开时忽略 |
| 0x1B | pushSend | 0 | JSON | 宿主请求中转发一条 APNs 推送（{deviceId, title, body, sessionId?, kind}）；只发给该实例登记过的令牌，APNs 未配置时零开销返回 |
| 0x1C | migrate | 0 | JSON `{"to":"<新中转地址>","at":<毫秒>}` | 宿主断开旧隧道之前登记「我搬到 `to` 了」；`to` 为空串表示撤销这条记录。中转只接受这条隧道自己登记的 instanceId，按实例记 30 天 |

帧编号的事实源是 `protocol-types.js`；保留编号仍要与插件一致，但 Rust 中转不会将这些旧业务帧当成配对或镜像指令处理。中转侧 60 秒收不到 pong 则断开隧道，宿主侧超时为 90 秒。

宿主按 `instanceId` 登记隧道，手机请求按 `X-Dsh-Instance` 分发；不存在的实例回 503。**那台实例在这条中转上留过未过期的迁移记录时**，这句 503 换成 `{"ok":false,"code":"migrated","to":"<url>","error":"that host moved to another relay"}`，并在响应头 `x-dsh-migrated-to` 带同一个地址（HTTP 与手机 WS 桥接同一条判据），手机据此自己切到新中转；没有记录时仍是原来那句 503，一个字都不变。没带实例头时，仅在恰好一台宿主在线时转发，不会在多台宿主间猜测。中转自答 `/healthz`、`/status`、`/api/mobile/v1/health` 和 `/api/mobile/v1/push-token`（推送令牌上报，判据与镜像读同一套设备凭据摘要），其余路径按规则转发；控制台路由见中转服务文档。
