#!/bin/sh
# 装一台中转，**不编译**：从更新源取编译好的静态包，校验和过了才装。
#
# 用法（root）：
#   sh install-binary.sh
#   RELAY_UPDATE_SOURCE=https://your-mirror.example/relay-updates sh install-binary.sh
#
# 为什么有这个脚本：另一份 install.sh 是「装 Rust → 编译几分钟」的源码路线，
# 给的是要改代码的人。普通部署照那个走等于让用户自己编译，不该有这条路。
#
# 拿到的包是静态链接的 musl 二进制，Rocky / Debian / Ubuntu / Alpine 同一份能跑，
# 所以这里不需要判断发行版，也不装任何运行时依赖。
#
# 刻意不做的：不配 TLS、不改 nginx（上证书的方式太多，猜一种就把别人的机器配歪）；
# 不开控制台（那要微信登录的三件套密钥）。跑完会打印反代片段。
set -eu

APP_DIR=/opt/dsh-relay
SERVICE=dsh-relay
PORT=18788
HOST=127.0.0.1
ENV_FILE=/etc/dsh-relay-update.env

# 默认更新源。**与发布流水线烤进二进制的默认源保持一致**
# （`.github/workflows/release-relay.yml` 的 DSH_RELAY_UPDATE_SOURCE）：国内镜像在前，
# 因为国内服务器基本连不上 github.com；海外机器第一个源也能连，只是慢一点。
DEFAULT_SOURCES="https://dsh-hub.wnluo.com/relay-updates,https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/relay-updates/relay-updates"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行（要写 $APP_DIR 与 systemd 单元）"
command -v curl >/dev/null 2>&1 || die "要 curl（下载清单与二进制）"
command -v systemctl >/dev/null 2>&1 || die "没有 systemd。Alpine / OpenRC 那套见 \$APP_DIR/deploy/openrc/（README 的「Alpine」一节）"

# ── 架构 ───────────────────────────────────────────────────────
case "$(uname -m)" in
    x86_64 | amd64) ARCH=x86_64 ;;
    aarch64 | arm64) ARCH=aarch64 ;;
    *) die "没有 $(uname -m) 的预编译包（只发布 x86_64 与 aarch64）。可以改用源码编译的 install.sh" ;;
esac
say "这台是 $ARCH"

# ── sha256 工具（coreutils / perl / openssl 三选一）────────────
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1; then
    sha256_of() { openssl dgst -sha256 "$1" | sed 's/.*= //'; }
else
    die "找不到 sha256 工具（sha256sum / shasum / openssl 都没有）"
fi

# ── 取清单：按顺序试每个源 ─────────────────────────────────────
SOURCES=${RELAY_UPDATE_SOURCE:-$DEFAULT_SOURCES}
TMP=$(mktemp -d /tmp/dsh-relay-install-XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM

MANIFEST=""
for src in $(printf '%s' "$SOURCES" | tr ',' ' '); do
    url="${src%/}/latest.json"
    if curl -fsS --max-time 20 "$url" -o "$TMP/latest.json" 2>/dev/null; then
        say "拿到清单：$url"
        MANIFEST="$TMP/latest.json"
        break
    fi
    echo "  取不到 $url，换下一个源" >&2
done
[ -n "$MANIFEST" ] || die "所有更新源都取不到 latest.json（试过：$SOURCES）"

# 只取本架构那一条。清单是同一份脚本生成的紧凑格式，用 pattern 抽而不是靠行号，
# 加个字段不至于把解析搞坏。
entry=$(tr -d '\n' <"$MANIFEST" | grep -o "\"$ARCH\":{[^}]*}" | head -1 || true)
[ -n "$entry" ] || die "清单里没有 $ARCH 这个架构的包"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
URL=$(printf '%s' "$entry" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
SHA=$(printf '%s' "$entry" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')
[ -n "$VERSION" ] && [ -n "$URL" ] && [ -n "$SHA" ] || die "清单里的版本 / 地址 / 校验和少了一样"

say "下载 dsh-relay $VERSION（$ARCH）"
curl -fL --max-time 900 --progress-bar "$URL" -o "$TMP/dsh-relay" || die "下载失败：$URL"
chmod 755 "$TMP/dsh-relay"

say "核对校验和"
actual=$(sha256_of "$TMP/dsh-relay")
if [ "$actual" != "$SHA" ]; then
    die "校验失败，什么都没装（期望 $SHA，实际 $actual）"
fi
echo "  $actual"

# 换上去之前先真的跑一次：架构不对、缺动态库、包是坏的，都在这里暴露，
# 而不是等装完起不来。判据同时是「能跑」和「自报的版本对得上」。
say "试跑"
reported=$("$TMP/dsh-relay" --version 2>&1) || die "这个包在这台机器上跑不起来：$(printf '%s' "$reported" | head -1)"
reported=$(printf '%s' "$reported" | head -1)
printf '%s' "$reported" | grep -q "$VERSION" || die "自报版本对不上（期望 $VERSION，输出：$reported）"
echo "  $reported"

# ── 装 ────────────────────────────────────────────────────────
install -d "$APP_DIR"/logs "$APP_DIR"/data "$APP_DIR"/deploy
if [ -f "$APP_DIR/dsh-relay" ]; then
    say "已经有装过的版本，先停服务再覆盖（运行中覆盖会撞 Text file busy）"
    systemctl stop "$SERVICE" 2>/dev/null || true
fi
install -m 0755 "$TMP/dsh-relay" "$APP_DIR/dsh-relay"
install -m 0755 "$(dirname "$0")/logrotate.d-dsh-relay" "$APP_DIR/deploy/logrotate.d-dsh-relay" 2>/dev/null || true

# 自动更新：装的时候就把开关打开，否则用户永远停在装的那一版，要自己盯更新。
# 单独一个 env 文件、已经存在就不动 —— 重装不能把用户改过的源冲掉
# （这条是 install.sh 那边踩出来的：整份重写单元文件会把 PLATFORM_* 全部抹掉）。
if [ ! -f "$ENV_FILE" ]; then
    umask 077
    cat >"$ENV_FILE" <<ENV
# 自动更新。想关掉就删掉 SELF_UPDATE，或整份删掉本文件。
SELF_UPDATE=1
# 更新源，按顺序试。换成你自己的静态目录（下面要能取到 latest.json）。
SELF_UPDATE_SOURCE=$SOURCES
ENV
    say "已写 $ENV_FILE（自动更新开着）"
else
    say "保留已有的 $ENV_FILE"
fi

# 已有的单元文件不归我们改。没引用那个 env 文件的话，开关写了也不会生效——说出来，
# 别让人以为「自动更新开着」。
if [ -f "/etc/systemd/system/$SERVICE.service" ] \
    && ! grep -q "$ENV_FILE" "/etc/systemd/system/$SERVICE.service"; then
    say "注意：现有单元没引用 $ENV_FILE，自动更新不会生效"
    echo "  在 [Service] 里加一行 EnvironmentFile=-$ENV_FILE，再 systemctl daemon-reload" >&2
fi

if [ ! -f "/etc/systemd/system/$SERVICE.service" ]; then
    cat >"/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=DSH Mobile relay (Rust, pure forwarding behind nginx)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOST=$HOST
Environment=PORT=$PORT
EnvironmentFile=-$ENV_FILE
EnvironmentFile=-/etc/dsh-relay-console.env
ExecStart=$APP_DIR/dsh-relay
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:$APP_DIR/logs/relay.log
StandardError=append:$APP_DIR/logs/relay.log

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
fi
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2

if curl -fsS -m 5 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
    say "起来了：http://$HOST:$PORT/healthz 回 ok（版本 $VERSION）"
else
    die "服务没应答。看日志：journalctl -u $SERVICE -n 50（或 $APP_DIR/logs/relay.log）"
fi

cat <<EOF

中转已经在 $HOST:$PORT 上跑着了，版本 $VERSION。还差最后一步：

  **把公网域名反代到 $HOST:$PORT**，而且必须是 https（App 的公网连接只认 https/wss）。
  nginx 最简写法：

    location / {
        proxy_pass http://$HOST:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

  然后 curl https://your-domain.example/healthz 应当回 ok，
  宿主的插件里把中转地址填成那个域名，手机扫码即可。

自动更新：已开（每 24 小时查一次，源在 $ENV_FILE 里）。
          以后有新版本会自己下载、试跑、替换、重启；起不来会自动回滚到上一版。
          查升级情况：$APP_DIR/logs/relay.log 里搜「自动更新」。

日志：$APP_DIR/logs/relay.log
二进制：$APP_DIR/dsh-relay

要开中转控制台（运营台）：把 PLATFORM_* 写进 /etc/dsh-relay-console.env（权限 600），
再 systemctl restart $SERVICE。
EOF
