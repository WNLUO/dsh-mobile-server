# dsh-relay（Rust）— 自建版中转

一个二进制：**纯转发的中转** + **可选的中转控制台**。

宿主端（跑在用户电脑上的 [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)）
主动向本服务建立一条出站 WSS 隧道；手机上来的 HTTP / SSE / WebSocket 原样送进那条隧道，
宿主的响应原样送回手机。所以本服务无需入站可达用户电脑的网络。

## 边界

- **多台宿主同时在线**。按宿主自报的实例 id（注册帧里的 `instanceId`）各存一条隧道，
  请求按手机带来的 `X-Dsh-Instance` 分发到对应那条。同一实例重连只顶掉它自己那条，
  别人的完全不受影响。**找不到就回 503，绝不退回到「随便挑一条」**——公用中转上随便挑
  等于把 A 家的请求送进 B 家的电脑。
- **不解释业务**。不缓存、不存镜像、不认路径语义；请求头与响应头除逐跳头与 `host`
  之外一律原样带过去。
- **准入默认不开**。不开控制台、或者控制台开着但准入模式是「开放」时，中转跟以前一样
  什么也不判。**限制模式**下宿主连隧道必须带有效激活码，在握手阶段就拒（回 401，连 ws
  都不建立）。

自己认领的路径只有 `/healthz`、`/api/mobile/v1/health`（地址体检）与 `/status`
（在线状态）；控制台打开时再加 `/api/platform/v1/**`、`/platform/**`，以及给宿主救急
用的 `/api/desktop-plugins/ota/*`。其余全部转发。

**没有带 `X-Dsh-Instance` 的请求会被拒（503）**：中转不知道它要去哪台，猜一个就是串台。
宿主连上来时也必须先发 `register` 帧自报实例 id，否则它收不到任何请求。

## 跑起来

### 一键装（推荐）

在一台装好 systemd 的 Linux 上，`root` 身份跑一次：

```sh
# 下安装脚本，跑一次（不用装 Rust，不编译）
curl -fsSLO https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/main/server/relay/rust/deploy/install-binary.sh
sudo sh install-binary.sh
```

它从更新源取**已经编好的静态包**（x86_64 / aarch64 各有），先核对 sha256、再真的跑一次
`--version` 确认这个包在这台机器上起得来，然后装到 `/opt/dsh-relay/`、写 systemd 单元并
启动（监听 `127.0.0.1:18788`），顺手把自动更新打开。跑完会打印 nginx 反代片段，把域名
指到那个端口就行。

包是静态链接的 musl 二进制，Rocky / Debian / Ubuntu / Alpine 共用同一份——不用挑发行版，
也不用装运行时依赖。

**它刻意不碰的东西**：不改你的 nginx、不配 TLS、不开控制台。原因写在脚本头上——上证书的
方式太多，脚本猜一种就会把别人的机器配歪；控制台要微信登录的三件套密钥，没有那三样的
机器开了也登不进去。

### 从源码装（要改代码才用这条）

```sh
git clone https://github.com/WNLUO/dsh-mobile-server.git
cd dsh-mobile-server/server/relay/rust
sudo ./deploy/install.sh
```

它做四件事：装 Rust（走国内镜像，官网在国内基本下不动）、编译、把二进制放到
`/opt/dsh-relay/`、写 systemd 单元并启动。**普通部署不要走这条**——编一次要装两百多兆
的工具链、等几分钟，而我们发布的包跟它是同一份代码编出来的。

源码编出来的二进制**不带默认更新源**，开自动更新必须自己指定 `SELF_UPDATE_SOURCE`；
从我们发布的包装的那份带了默认源（`SELF_UPDATE=1` 就够）。这条差别是刻意的：自己编的
不应该被官方二进制悄悄换掉。

### 手动装

```sh
cargo build --release
./target/release/dsh-relay          # 默认 0.0.0.0:8700
```

注意 `Cargo.toml` 通过相对路径引用同仓库的 `server/relay-core/rust`，所以要在
`server/relay/rust` 里编，别单独把这一层拷走。

生产环境给它配一个带 TLS 证书的域名——App 走公网只接受 HTTPS/WSS。

systemd：

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH Mobile relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/dsh-mobile/dsh-relay
Environment=PORT=8700
# 控制台：只放登录相关的几个键，单独一个 0600 文件
EnvironmentFile=/etc/dsh-relay-console.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 环境变量

转发相关的全部可选，一个必填项都没有：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8700` | 监听端口 |
| `MAX_FRAME_BYTES` | 8 MB | 单帧上限 |
| `MAX_BODY_BYTES` | 67 MB | 请求体上限（信封让线上字节按 4/3 变大，总闸跟着抬） |
| `MAX_PENDING` | 256 | 同时在途的请求数 |
| `MAX_SSE_CONNECTIONS` | 64 | 同时开着的 SSE 条数（**按隧道算**，即一台宿主电脑上所有设备共用一个数） |
| `MAX_SSE_PER_DEVICE` | 3 | 同一台设备最多同时占几条 SSE。超了不是拒绝，而是把它自己最早那条顶掉 |
| `MAX_WS_CONNECTIONS` | 256 | 手机 WS 条数 |
| `TUNNEL_HEARTBEAT_MS` | 15000 | 隧道 ping 周期 |
| `TUNNEL_PONG_TIMEOUT_MS` | 60000 | 多久没 pong 算死链 |
| `WS_HEARTBEAT_MS` | 15000 | 手机 WS ping 周期 |
| `WS_PONG_TIMEOUT_MS` | 60000 | 手机 WS 半开判定 |
| `DEBUG_SSE` | 关 | 打 SSE 开/关日志 |
| `SELF_UPDATE` | **关** | 打开后这台中转会自己升到更新源上的新版本 |
| `SELF_UPDATE_SOURCE` | 见下 | 更新源，下面要能取到 `latest.json`。**多个源用逗号分隔，按顺序试** |
| `SELF_UPDATE_INTERVAL_SECONDS` | 86400 | 查新版本的间隔，越界（小于一天 / 大于一周）**报错**，不 clamp |

`SELF_UPDATE_SOURCE` 的默认值分两种：**官方预编译包**里烤了一组默认源（国内镜像在前、
GitHub 那份清单在后），所以 `SELF_UPDATE=1` 就够；**自己 `cargo build` 出来的没有默认源**，
`SELF_UPDATE=1` 又不给地址会直接启动报错。这条差别是刻意的——源码编的机器不该被官方
二进制悄悄替换掉。

越界的值**直接报错启动失败，不是 clamp**——手滑写个 0 被静默接受，表现是「限额关掉了」
而不是「设错了」。

名额满了回 `429`，正文是 `relay resource limit exceeded`（纯文本），带 `retry-after: 25`，
同时打一行 `capacity rejected: sse=当前/上限 pending=当前/上限 accept-sse=…`（一分钟内同类
拒绝只逐条记第一行，其余累加成计数）。这一行是排
「手机上突然一片 429」的唯一线索：`sse` 到顶说明长连接名额被占满（一台手机正常只占两条，
会话流 + 设备级流；到顶多半是设备太多或者有被丢弃的连接没关），`pending` 到顶则是那一批
短请求堆住了。

同一台设备开新的 SSE 时，如果它已经占满 `MAX_SSE_PER_DEVICE` 条，最早那条会被顶掉
（打一行 `sse superseded`），而不是让新连接排队——一台陷在重连风暴里的设备只该饿死自己。
写回手机时一次写最多等 60 秒，超时就收尾（`write stall`）：手机把 socket 攥着不再读的
时候，光看上游有没有数据是判不出来的，因为心跳会一直喂着。

## 中转控制台

不设 `PLATFORM_ENABLED` 时整套不生效，中转就是纯转发，行为跟没有控制台时一模一样。
打开之后：

- 网页在 `/platform/`，接口在 `/api/platform/v1/`。
- **第一个用微信登录的人自动成为管理员**（也可以用 `PLATFORM_ADMIN_SUBS` 指名）。
- 管的是：**谁能建隧道**（准入模式 + 激活码 + 设备绑定），不是谁能配对。配对码、设备
  凭据、移动 token 仍然全在宿主侧，中转不碰。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PLATFORM_ENABLED` | 关 | 设成 `1` 才装控制台 |
| `PLATFORM_PUBLIC_BASE_URL` | `https://your-domain.example` | 对外基址，**必须改成你自己的域名**。登录回跳与 OTA 下载地址都按它拼，**不反射请求的 Host** |
| `PLATFORM_DB_PATH` | `data/console.db` | SQLite 库文件，生产数据 |
| `PLATFORM_WEB_ROOT` | `<二进制旁边>/dist-console` | 面板前端产物目录，`npm run build:relay-console` 生成 |
| `PLATFORM_SESSION_SECRET` | — | 会话密钥，至少 16 字符（不够只警告、不挡启动） |
| `PLATFORM_SESSION_COOKIE` | `dsh_platform_session` | 会话 cookie 名，改名等于所有人掉线 |
| `PLATFORM_SESSION_TTL_SECONDS` | 30 天 | 会话有效期 |
| `PLATFORM_OIDC_ISSUER` | 空 | 你的 OIDC 登录系统基址 |
| `PLATFORM_OIDC_REDIRECT_URI` | 由 public base + web prefix 拼出 | 回调地址，**必须在登录系统那边登记过** |
| `PLATFORM_OIDC_CLIENT_ID` / `_CLIENT_SECRET` / `_SCOPE` | — | 微信 OIDC 客户端 |
| `PLATFORM_ADMIN_SUBS` | 空 | 逗号分隔的身份白名单，命中直接提管理员（按 `sub:` / `openid:` 前缀形式填） |
| `PLATFORM_BOOTSTRAP_FIRST_ADMIN` | 开 | 冷启动第一个登录的用户即管理员 |
| `PLATFORM_MASTER_URL` | 空 | **设了这台就是被控端**，定期向主控端上报 |
| `PLATFORM_CLAIM_CODE` | 空 | 被控端的认领码（主控端着面板上生成） |
| `PLATFORM_MASTER_TOKEN` | 空 | 被控端上报时带的 Bearer；主控端设了同一个值就只认带它的上报 |
| `PLATFORM_NODE_NAME` | 主机名 | 上报出去的名字 |
| `PLATFORM_ACCEPTS_REPORTS` | 开 | 主控端是否接收上报 |
| `PLATFORM_REPORT_INTERVAL_SECONDS` | 300 | 被控端多久报一次。**它也是主控端下发模式的生效上限**；填小于 30 会被夹到 30 |
| `PLATFORM_OTA_ROOT` | `data/plugin-ota` | 救急 OTA 包的落盘目录 |
| `PLATFORM_OTA_CONTROL_TOKEN` | 空 | 发布 OTA 的 Bearer；**不设则发布接口整个关闭**（下载不受影响） |
| `PLATFORM_RATE_LIMIT_WINDOW_SECONDS` | 60 | 限流窗口 |
| `PLATFORM_LICENSE_RATE_LIMIT` | 30 | 一个窗口里同一来源最多调几次激活码校验/绑定 |
| `PLATFORM_REPORT_RATE_LIMIT` | 60 | 一个窗口里同一来源最多上报几次 |

准入模式在面板上切，默认 **开放**——从纯转发升级上来的人不会突然连不上。

### 主控端 / 被控端

一套代码两种角色，按配置区分：配了 `PLATFORM_MASTER_URL` 就是被控端，没配就是自成一体的
中转（同时也是自己那组的主控端）。

- 被控端每 5 分钟向主控端的 `/api/platform/v1/nodes/report` POST 一份聚合状态（隧道在不在、
  码数、设备数），认领码走 `x-dsh-claim` 头。
- **主控端只收状态，不碰隧道流量**：主控端挂了，所有被控端照常转发，只是看不到报表。
- 上报端点不走微信登录（被控端没有账号），只认认领码；主控端配了 `PLATFORM_MASTER_TOKEN`
  就再要求一个匹配的 Bearer——**两边填错地址时不会把状态推进陌生人的面板**。

**主控端能改被控端的准入模式。** 面板上每台被控端都有「开放 / 限制 / 交还给它」三个按钮。
改的是主控端这边记下的**期望值**，被控端在**下一次上报的响应里**把它取回去落地，不新增
端点、不新增心跳。

- **最长一个上报周期才生效**（默认 5 分钟）。主控端从不主动连被控端（否则被控端就得开
  入站口），所以只能等它自己来问。面板上「它现在」和「已下发」两栏并排显示，就是在等
  这个窗口。
- **「交还给它」** 清掉期望值，之后那台本地设什么就是什么——**从没下发过的机器行为完全不变**。
- **被接管之后，被控端本地面板上那个开关会灰掉**，并写明「由主控端管理」。不灰的话，
  改了下一轮也会被掰回去，那比灰着更让人以为是 bug。
- **改的只有准入模式这一个字段**，不是通用指令通道。
- 主控端挂了，已经落地的那份设置继续作数，不会自己变回去。

**移除一台被控端不删记录。** 主控端点「移除这台」只打一个 `revokedAt` 时间戳：

- 主控端面板上它变成「已移除」，看得见这里曾经有过一台机器；确认不会回来了可以「彻底删除」。
- 被控端之后上报会拿到 **403**（说「被这台主控端移除了」），而不是 404。它据此知道该去
  要一个新认领码，而不是去核对主控地址——这两件事的处置完全不同。
- 想让它重新挂上来：在面板上重新生成一个认领码，填给它。

**被控端面板会显示上报链路本身的状态**：上次成功报到的时间、最近一次失败的原因、多久
报一次。只写日志的话，开着面板的人不知道自己这台在主控端那边已经掉线了。

### 救急 OTA

正式分发归 npm 插件市场，中转上这条只是给宿主里那条临时通道用的：

```sh
curl -X POST -H "authorization: Bearer $TOKEN" --data-binary @pkg.tar.gz \
  "https://你的域名/api/desktop-plugins/ota/publish?platform=darwin&channel=stable&version=0.1.61"
```

包里必须是以 `package/` 打头的 tar，且含 `package.json` 与 `lib/impl.js`。**macOS 直接
打的包带 PAX 头，宿主那个解析器不认**，要 `COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata`。

## 开发

从仓库根目录安装面板依赖并运行：

```sh
npm ci
npm ci --prefix server/relay/rust/console
npm run test:relay-core
npm run test:relay
npm run build:relay
npm run test:e2e
```

`build:relay` 编 release 二进制并构建控制台前端。端到端用 `test/fake-desktop.js` 作为参考宿主，
共享同仓测试协议实现；WebSocket 测试依赖由仓库根目录的 `ws` 提供。它**不发 `register` 帧**，
所以测不出注册回执那条路；控制台的准入是用裸 ws 探测验的。

发布后确认线上跑的是哪份代码：`curl https://你的域名/api/platform/v1/config` 会带回
`buildId`。cargo 会按文件 mtime 跳过编译，改了源码记得 `touch` 再编，别信「Finished」。

## 限流

只有两个入口限流，因为只有这两个是**匿名可调**的：

- `POST /api/platform/v1/licenses/verify` 与 `/licenses/bind`
- `POST /api/platform/v1/nodes/report`

别的接口要么要登录、要么是只读的状态查询。限流按来源 IP 计数，来源优先取 nginx
传进来的 `x-real-ip`（本机 nginx 覆盖写入，客户端改不了）；**不看 `x-forwarded-for`**，
那是客户端自己填的。

注意这不是防爆破设计——激活码是 32^16 的码空间，猜不中。限流要解决的是**成本**：
不给一个免费的查询服务拿去刷。所以默认额度定得很松（一分钟 30 次），正常用户手抄
一个码、填错两三次再改对，远远够。

另外激活码校验**不区分「不存在」和「已吊销」**，两者都回 `invalid`。分开回等于
告诉对方「你这个码是真的」，那又是一个免费的存在性查询。真正吊销的那条在审计
日志与面板上都有记录，不靠这里告诉外人。

## 运维

两条脚本在 `deploy/` 下，都是部署到服务器上执行的，不进二进制：

- **`logrotate.d-dsh-relay`** → `/etc/logrotate.d/dsh-relay`。日志由 systemd 的
  `StandardOutput=append:` 直接写，进程一直握着同一个 fd，所以用 `copytruncate`：
  拷一份再把原件清空。按 50M 切、留 7 份。不切的话磁盘写满时第一个坏掉的是同一个
  分区上的 SQLite。
- **`backup-console-db.sh`** → 每天凌晨 3 点跑一次（`/etc/cron.d/dsh-relay-backup`）。
  用 `sqlite3 .backup` 而不是裸拷文件——WAL 模式下直接拷 `.db` 会漏掉没 checkpoint
  的页。备份完**当场验一遍**（能打开、关键表在、行数非空），验不过就删掉并报错，
  免得安静地产生一个坏文件让人以为有保险。留 30 份。

  恢复演练（每次改这个脚本都该跑一遍）：

  ```sh
  T=$(mktemp -d)
  gunzip -c /opt/dsh-mobile/backups/console-<最新的>.db.gz > $T/restored.db
  PORT=18799 HOST=127.0.0.1 PLATFORM_ENABLED=1 PLATFORM_DB_PATH=$T/restored.db \
    PLATFORM_SESSION_SECRET=0123456789abcdef0123456789abcdef PLATFORM_OIDC_CLIENT_SECRET=x \
    /opt/dsh-mobile/dsh-relay      # 另一个端口起一份，确认 /health 通、面板能开
  ```

## 自动更新

**出厂是关的。** 从我们发布的包装的那种，安装脚本会把它打开（写进
`/etc/dsh-relay-update.env`），因为发布渠道只有我们这一条，不打开等于用户永远停在装的
那一版。关着的时候什么都不会发生，转发一个字都不变。

**默认源由包内置**：国内镜像在前、GitHub 上那份清单在后，按顺序试。所以用官方包时只要：

```sh
SELF_UPDATE=1
```

想换成自己的静态目录就覆盖掉：

```sh
SELF_UPDATE_SOURCE=https://your-domain.example/relay-updates
```

自己 `cargo build` 出来的二进制**没有内置默认源**，`SELF_UPDATE=1` 又不给地址会直接启动
报错退出（不静默跳过）。这是刻意的：早先写死过我们自己的运营机，那意味着「开了自动更新
但没改源」的用户会来别人的域名取二进制、校验通过、替换掉自己的程序——那不是更新，是把
远程执行的口子交给了一个陌生人。源码编的机器现在同样不许有这个默认。

**为什么 GitHub 排在后面**：试过。`api.github.com` 在国内能连，但 Release 资产真正的
下载域名 `github.com` 连不通；绕开它走 API 的资产直链也只有几十 KB/s，8MB 的二进制
要下一个多小时。所以国内镜像当主力，GitHub 那份清单是**主源挂了**时的兜底。

### 换上去之前先试跑，换上去之后自己验收

自动更新最坏的形态不是「没升上去」，是「升上去之后起不来，而且没人知道」。所以从下载到
定案有四道闸，任何一道不过就退回旧版本继续服务：

1. **校验和**。清单里写着 sha256，对不上就连临时文件都不留。
2. **试跑**。替换前先在可执行文件旁边跑一次 `dsh-relay --version`，能起来、能报出清单声明
   的版本号，才允许换。拦的是「这个包在这台机器上根本跑不了」——动态链接的包下发到 musl
   系统上，进程连 `main` 都进不去，它自己没机会回滚。暂存文件放在 exe 旁边而不是数据目录，
   因为 `rename` 不能跨文件系统，而数据目录常常跟着数据库路径被挪到别的盘。
3. **自检**。换上去之后退出、由服务管理器拉起新版；新版绑上端口后自己打一次 `/healthz`，
   拿到 200 才算这次升级成立。
4. **数次数**。万一新版在自检之前就死了（panic、配置错），同一个版本连续两次启动都没验明，
   第二次启动时直接把 `.previous` 换回来。

换回之后写一条回滚记录，**之后不再自动升级**，直到人上去把 `.update-state` 删掉。状态文件
里那几行就是现场：`pending` / `attempts` / `confirmed` / `rollback`。

**跟控制台无关**：纯转发的机器（没设 `PLATFORM_ENABLED`）一样能自己升级。状态记在数据
目录的 `.update-state` 里，是个纯文本文件，不碰数据库。

更新源是一个自己控制的静态目录：一个 `latest.json` 加若干二进制。

```json
{
  "version": "0.1.1",
  "binaries": {
    "x86_64": { "url": "https://your-host/relay-updates/dsh-relay-linux-x86_64", "sha256": "…" }
  }
}
```

### 发布一个版本

**编包不在这台机器上做**。打 tag 推上去，GitHub Actions 会编两份静态包（x86_64 与
aarch64）、各自验一遍真静态与架构、ARM64 还会用 qemu 跑一次 `--version`，然后挂到
`rust-v<版本>` 这个 Release 上：

```sh
# 先抬 server/relay/rust/Cargo.toml 的 version 并提交
git tag rust-v0.1.14 && git push origin rust-v0.1.14
```

tag 和 `Cargo.toml` 里的版本对不上，CI 直接失败——同一版本号两份二进制是这个项目踩过的
坑（机器上跑的和你以为发出去的不是同一份）。不想打 tag 也可以手动触发那个 workflow，
只出包、不挂 Release。

**Release 出来不等于发布了**：清单（`latest.json`）还没动，那会儿一个用户都收不到更新。
出包之后按「预发 → 正式」两步走：

```sh
# 1. 预发：只有把 canary 地址写在 SELF_UPDATE_SOURCE 最前面的那台会升
RELAY_UPDATE_CHANNEL=canary \
RELAY_UPDATE_ROOT_CANARY=/opt/dsh-mobile/relay-updates-canary \
RELAY_UPDATE_PUBLIC_BASE_CANARY=https://dsh-hub.wnluo.com/relay-updates-canary \
./deploy/publish-relay-update.sh 0.1.14 /abs/path/dsh-relay-linux-x86_64 /abs/path/dsh-relay-linux-aarch64

# 2. 那台升上去、跑一段，看过日志与 /status 的 hostConnected 之后，发正式
./deploy/publish-relay-update.sh 0.1.14 /abs/path/dsh-relay-linux-x86_64 /abs/path/dsh-relay-linux-aarch64
```

发布脚本会先把二进制放进 `<更新源>/`、再写 `latest.json`（**顺序有讲究**：反过来会让中转
在「清单已更新、文件还没到」的窗口里下到 404），然后当场自检——把清单里的地址真的取
一遍、比对哈希。自检不过就报错退出，不会留下一个你自己都下不来的版本。

发到第二个更新源（国内一个、海外一个）加两个环境变量，按位置一一配对：

```sh
RELAY_UPDATE_EXTRA_ROOTS=/mnt/gh/relay-updates \
RELAY_UPDATE_EXTRA_BASES=https://raw.githubusercontent.com/OWNER/REPO/main/relay-updates \
./deploy/publish-relay-update.sh 0.1.8 /abs/path/dsh-relay-linux-x86_64
```

每个镜像目标都会单独自检一次。一个取不下来的海外源，等于海外那批机器静默停更。

**发之前确认包里内置的版本号等于你要发的版本**：脚本会用 `strings` 读一遍并拦住不一致。
忘了抬 `Cargo.toml` 就发布，机器升上去自报旧版本、下次又认为该升，于是每天下载替换重启
一次、永远停不下来。

### 跨发行版：发静态包

Linux 上有 glibc（Rocky / Debian / Ubuntu）和 musl（Alpine）两套 C 库，动态链接的包
不能混用——实测把 glibc 包放到 Alpine 上直接缺 `libgcc_s`，补 `gcompat` 也还缺
`fcntl64` / `__res_init`。

所以对外发布统一发**静态包**（CI 的 `release-relay.yml` 就是干这个的），RUSTFLAGS 里
显式 `-C target-feature=+crt-static -C relocation-model=static`。少了后者编出来的是
static-pie（file 会显示 `interpreter /lib/ld-musl-x86_64.so.1`），在 Rocky 和 Debian 上
照样起不来。产物在 CI 里用 `file`（要 `statically linked`）、`readelf`（不许有 `INTERP`）
和真跑一次 `--version` 验收。

要在本机编一份同样的静态包（改完代码想立刻验），`deploy/build-static.sh` 走的是同一套
参数，但它要 docker。

同一个版本号重复发布会直接拒绝：机器上跑的版本没变、问题却以为已经修了，是发布
事故最常见的形态。

### 升级是怎么做的

下载到临时文件 → 算 sha256 比对清单（**对不上就放弃，什么都不动**）→ 试跑一次
`--version` → 当前二进制改名留成 `.previous` → 新文件原子换上去 → 退出，由进程管理器
拉起来 → 新版自打一次 `/healthz` → 成了记 `confirmed`，没成换回 `.previous`。

**校验的边界**：能挡传输损坏、挡不住同时改了清单和二进制的人。真要防那个得上签名，
那要引入密钥管理，对一台自发布的中转成本大于收益。

**最坏情况是白折腾一轮，不会留下一台起不来的机器**：任何一道闸不过都会退回旧版本继续
服务，并留下一条回滚记录停掉后续自动升级，等人来看。删掉数据目录下的 `.update-state`
再重启才会恢复。
