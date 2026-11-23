# DSH 隧道协议 v2

手机通过 HTTPS/WSS 连接 Rust 中转，宿主插件主动连 `/tunnel` 建立出站 WSS 隧道。中转只转发 HTTP、SSE、WebSocket；移动端鉴权与配对由宿主处理。中转控制台可选启用，限制模式下在隧道握手前检查激活码。

每条隧道消息是一个 WS binary 帧：

```
[type: 1B][id: 4B 大端][length: 4B 大端][payload: length B]
```

`id=0` 表示控制帧；`id=N` 对应一条请求。JSON 载荷使用 UTF-8；二进制数据原样传输。

| type | 名称 | id | 载荷 | 用途 |
|---|---|---|---|---|
| 0x01 | register | 0 | JSON `{instanceId, name?, version?, license?, secret?, lanUrls?, lanCandidates?}` | 宿主登记实例；同一实例重连只取代自己。`version` 是宿主正在跑的三段插件版本：中转记录它，配置 `MIN_PLUGIN_VERSION` 时拒绝低于门槛或没报有效版本的宿主。`license` 供控制台准入复核；配置 `TUNNEL_REGISTER_SECRET` 时 `secret` 必须匹配。`name/lanUrls/lanCandidates` 是宿主附带的元信息，当前 Rust 中转不据此选路。**不发送 pairingCode** |
| 0x02 | registered | 0 | JSON `{ok, mirror, blobUpload?}` | 中转确认注册。`mirror` 是本节点的镜像口径：`false`（`MIRROR_CACHE=0` 的纯转发节点）表示收下整份镜像也只留凭据摘要、正文解析完就丢，宿主据此只推摘要帧（清单与工作区各只带 `ok`+`revision`、外加 `creds`）。老宿主只认帧类型、不读内容，多这个字段没有影响。`blobUpload` 是本连接的分片上传能力，见下节 |
| 0x03 | updatePairing | 0 | JSON `{}` | 保留编号，宿主不再发送，中转不读取 |
| 0x04 | httpRequest | N | JSON `{method, path, headers}` | 手机请求头送到宿主 |
| 0x05 | httpBody | N | bytes | 请求体；空载荷表示结束 |
| 0x06 | httpHead | N | JSON `{status, headers}` | 宿主响应头 |
| 0x07 | httpChunk | N | bytes | 宿主响应体（含 SSE） |
| 0x08 | httpEnd | N | 空 | 响应结束 |
| 0x09 | httpError | N | JSON `{message}` | 上游错误 |
| 0x0A | wsUpgrade | N | JSON `{path, headers}` | 手机 WS 升级请求 |
| 0x0B | wsOpen | N | 空 | 上游 WS 已连接 |
| 0x0C | wsError | N 或 0 | JSON `{message, code?}` | `id=N` 表示上游 WS 错误；`id=0` 表示中转拒绝并即将关闭隧道。准入拒绝可只有 `message`；`code` 可为 `bad_register_secret`、`instance_mismatch`、`plugin_too_old`。版本拒绝附 `min` / `have` / `retryAfterMs`，宿主据此长退避；未知 code 仍按 message 显示拒绝原因 |
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
| 0x1C | migrate | 0 | JSON `{"to":"<新中转地址>","at":<毫秒>}` | 宿主断开旧隧道之前登记「我搬到 `to` 了」；`to` 为空串表示撤销这条记录。当前中转已不再据此指路（地址由总控下发），此帧保留在类型表里以兼容宿主发送 |
| 0x1D | blobPut | 0 或 N | JSON：旧 `{scope, key, creds, cipher}`；协商分片/ack 见下节 | 宿主把用实例历史密钥（HK）加密好的历史 blob 推给中转：`scope` 为 `messages` 或 `file`，`key` 是 sessionId / fileId，`creds` 是本实例当前有效设备凭据的 `[{hash, expiresAt}]`（sha256 hex + 过期毫秒，供中转做拉取鉴权），`cipher` 是信封字节的 base64url。旧 `id=0` 仍发整包，`cipher` 为空串表示**只更新 creds/元数据**、不动已落盘的密文；没有分片回执。协商后 `id=N` 复用同一编号双向传片/回执。中转**只存密文、永不持钥、永不解密**；`BLOB_STORE` 关时旧控制帧仍直接忽略 |
| 0x1E | blobDelete | 0 | JSON `{scope, key}` 或 `{scope, keys:[...]}` | 宿主让中转删掉已推过的 blob（会话删除 / 归档清空 / 吊销全部）。只删这条隧道自己登记的 instanceId 名下的条目 |

帧编号与线格式常量的事实源是 `protocol-types.js`，载荷字段与行为以本文为准；保留编号仍要与插件一致，但 Rust 中转不会将这些旧业务帧当成配对或镜像指令处理。中转侧 60 秒收不到 pong 则断开隧道，宿主侧超时为 45 秒。

宿主按 `instanceId` 登记隧道，手机请求按 `X-Dsh-Instance` 分发；不存在的实例回 503。没带实例头时，仅在恰好一台宿主在线时转发，不会在多台宿主间猜测。中转自答 `/healthz`、`/status`、`/api/mobile/v1/health`、`/api/mobile/v1/push-token`（推送令牌上报，判据与镜像读同一套设备凭据摘要）和 `GET /api/mobile/v1/blob/<scope>/<key>`（历史 blob 拉取，只在 `BLOB_STORE` 开时认领；关着时照常转发/404），其余路径按规则转发；控制台路由见中转服务文档。

## blob 分片上传

中转仅在 blob 仓库真实可用时，在 `registered` 中提供：

```json
{"ok":true,"mirror":false,"blobUpload":{"maxChunkBytes":49152,"maxBlobBytes":5242880}}
```

`maxBlobBytes` 是本节点配置的单条密文上限，示例为 5 MiB；`maxChunkBytes` 当前为 49152。两者均须为正的安全整数。`blobUpload` 缺失、关闭或任一上限无效时，宿主不使用分片，继续发旧 `blobPut id=0`。旧整包与 `cipher:""` 凭据刷新语义保持不变，凭据刷新始终走 `id=0`。协商只对当前连接有效，断线或 stop 后清除，重连重新读取 `registered`。

分片仍用 `blobPut=0x1D`，宿主以非零 `u32` 递增 id 标识上传。每条隧道最多一条在途上传，blob 的未决回执表与 HTTP/WS 的 pending 独立，按帧类型与方向分流。宿主发片，中转以相同类型、相同 id 回 ack：

- 首片：`{scope,key,creds,offset:0,total,final,cipher}`。
- 后续片：`{offset,total,final,cipher}`，可省略首片的 `scope/key/creds`。
- 成功回执：`{ok:true,nextOffset,done}`。
- 失败回执：`{ok:false,nextOffset:0,done:false,error}`，`error` 为错误文字。

`cipher` 是**每片独立编码**的 base64url。`offset`、`total`、`nextOffset` 与两个能力上限都按解码后的信封字节计量；宿主先切信封字节再分别编码，不能按 base64 文本截片。每片从中转上次确认的 `nextOffset` 接着发，`total` 固定且大于零，不超过 `maxBlobBytes`；解码后的每片非空且不超过 `maxChunkBytes`。非尾片必须满足 `offset + 片长 < total` 且 `final:false`；尾片必须满足 `offset + 片长 === total` 且 `final:true`。不允许零长上传或空尾片。

宿主一次只发一片，收到该片 ack 后才发下一片，每片服从既有字节背压并让出共享发送队列。成功 ack 的 `nextOffset` 只确认已写入临时文件的字节；`done:false` 不代表 blob 已发布。只有完整校验、预算接受和原子持久化发布全部成功，最终 ack 才返回 `done:true`，宿主据此清除 dirty。

失败 ack 会丢弃本次临时上传，旧的完整 blob 保持可读；宿主保留 dirty，由既有下一轮以新 id 从零重推，不做片内重传。断线或 stop 拒绝未决回执并清理临时上传，迟到的其他 id ack 忽略。

临时上传在中转连续90秒未收到下一条上传命令时回收；这量的是片间空闲，不是整份上传耗时。宿主的逐片确认、发送背压与隧道存活期限仍独立生效；到期后的续片会收到从零重推的失败回执，旧完整 blob 不受影响。
