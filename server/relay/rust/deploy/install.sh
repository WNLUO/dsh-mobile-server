#!/usr/bin/env bash
#
# 一键安装并启动 dsh-relay。
#
# 用法（在仓库根目录）：
#   sudo ./deploy/install.sh
#
# 它做的事，按顺序：
#   1. 编译（没装 cargo 就先装 rustup）；
#   2. 落二进制到 /opt/dsh-relay/；
#   3. 写 systemd 单元并启动，监听 127.0.0.1:18788；
#   4. 打印下一步（域名反代）。
#
# 刻意不做的：
#   - 不配 TLS、不改 nginx。上证书的方式太多（nginx / Caddy / 云厂商 CDN / Cloudflare），
#     脚本猜一种就会把别人的机器配歪。它只保证**本机**起得来，你把 443 反代到
#     127.0.0.1:18788 就行（App 走公网只认 https/wss）。
#   - 不开控制台。控制台要微信登录的三件套密钥，没有那三样的机器开了也是个登不进去的空壳。
#     要开的话见 README 的「中转控制台」一节。
#   - 不自动更新。自动更新要从别人的服务器下载二进制再替换自己，默认开等于给别人一个
#     远程执行的口子。README 有开启方式与前提。
set -euo pipefail

APP_DIR=/opt/dsh-relay
SERVICE=dsh-relay
PORT=18788
HOST=127.0.0.1

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（要写 /opt 与 systemd 单元）"

# 仓库里 relay 与 relay-core 是并列的两个目录，用相对路径互相引用；
# 所以必须在 relay/rust 里编译，别单独把这一层拷走。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$REPO_ROOT/Cargo.toml" ]] || die "没找到 Cargo.toml，请在 relay/rust 目录下运行"

say "1/4 检查 Rust 工具链"
if ! command -v cargo >/dev/null 2>&1; then
  say "没装 cargo，从 rustup 安装（约 200MB，只装一次）"
  # **走国内镜像**。官网 static.rust-lang.org 在国内实测几分钟都下不完一个 8MB 的
  # rustup-init，一键部署会卡在第一步 —— 用户看到的只是「没动静」。rsproxy.cn 实测
  # 1.7MB/s。想用官方源就把 RUSTUP_DIST_SERVER 换成 https://static.rust-lang.org。
  export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER:-https://rsproxy.cn}"
  export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT:-https://rsproxy.cn/rustup}"
  curl -sSf "$RUSTUP_DIST_SERVER/rustup/dist/x86_64-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init \
    || die "下载 rustup-init 失败，检查网络或设 RUSTUP_DIST_SERVER"
  chmod +x /tmp/rustup-init
  /tmp/rustup-init -y --profile minimal --no-modify-path
  rm -f /tmp/rustup-init
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
  # crates 也走镜像，否则拉依赖同样卡住。
  mkdir -p "$HOME/.cargo"
  grep -q 'rsproxy' "$HOME/.cargo/config.toml" 2>/dev/null \
    || cat >> "$HOME/.cargo/config.toml" <<'CFG'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
CFG
fi
cargo --version

say "2/4 编译（首次要几分钟，依赖较多）"
cd "$REPO_ROOT"
cargo build --release

say "3/4 安装到 $APP_DIR"
install -d "$APP_DIR"/{logs,data,deploy}
install -m 0755 target/release/dsh-relay "$APP_DIR/dsh-relay"
install -m 0755 deploy/logrotate.d-dsh-relay "$APP_DIR/deploy/logrotate.d-dsh-relay" 2>/dev/null || true
install -m 0755 deploy/backup-console-db.sh "$APP_DIR/deploy/backup-console-db.sh" 2>/dev/null || true

# 控制台前端产物：有就一起装，没有就算了（控制台默认不开，没有产物只影响打开面板）。
if [[ -d dist-console ]]; then
  rm -rf "$APP_DIR/dist-console"
  cp -a dist-console "$APP_DIR/dist-console"
fi

say "4/4 写 systemd 单元并启动"
# **重装不能把用户已有的配置冲掉**。单元文件每次都会被整份重写，而控制台的
# `PLATFORM_*`（开关、公开地址、库路径、前端产物目录）只能由部署方给；早先这些是写在
# 单元里的，重跑一次安装就全丢了，表现是「装完运营台没了、请求变成找不到实例头」。
# 所以那些键一律放进独立的 env 文件（`EnvironmentFile=-` 是可选的，没有也能起）。
CONSOLE_ENV=/etc/dsh-relay-console.env
if [ -f "$CONSOLE_ENV" ]; then
  say "检测到已有的 $CONSOLE_ENV，保留原样（其中的 PLATFORM_* 会继续生效）"
fi
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=DSH Mobile relay (Rust, pure forwarding behind nginx)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOST=$HOST
Environment=PORT=$PORT
# 控制台开关与微信登录密钥：需要的话写进这个文件，权限 600。
EnvironmentFile=-/etc/dsh-relay-console.env
ExecStart=$APP_DIR/dsh-relay
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:$APP_DIR/logs/relay.log
StandardError=append:$APP_DIR/logs/relay.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 2

if curl -fsS -m 5 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  say "起来了：http://$HOST:$PORT/healthz 回 ok"
else
  echo
  die "服务没应答。看日志：journalctl -u $SERVICE -n 50（或 $APP_DIR/logs/relay.log）"
fi

cat <<EOF

中转已经在 $HOST:$PORT 上跑着了。还差最后一步：

  **把公网域名反代到 $HOST:$PORT**，并且必须是 https（App 的公网连接只认 https/wss）。

  nginx 最简写法：

    server {
        listen 443 ssl http2;
        server_name your-domain.example;
        # ssl_certificate ...
        location / {
            proxy_pass http://$HOST:$PORT;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
        }
    }

  然后 curl https://your-domain.example/healthz 应当回 ok。

  宿主插件里把中转地址填成那个域名，手机扫码即可。

想开中转控制台（运营台）：把 PLATFORM_ENABLED / PLATFORM_PUBLIC_BASE_URL /
PLATFORM_DB_PATH / PLATFORM_WEB_ROOT 写进 $CONSOLE_ENV（权限 600），再 systemctl restart。
重跑本脚本不会覆盖那个文件。

日志：$APP_DIR/logs/relay.log
二进制：$APP_DIR/dsh-relay
数据库（控制台开启后）：$APP_DIR/data/console.db
EOF
