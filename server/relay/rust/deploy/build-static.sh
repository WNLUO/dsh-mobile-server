#!/bin/sh
# 编一个真正静态链接的 dsh-relay（musl），供 Alpine 之类没有 glibc 的机器直接跑。
#
# 用法（在哪儿调都行，脚本自己找 Cargo.toml）：
#   ./deploy/build-static.sh
#   OUT_DIR=/tmp/out ./deploy/build-static.sh
#
# 为什么是 docker + musl-gcc，而不是别的两条路：
#
# 1. musl.cc 的交叉工具链从国内机器上下不动。实测 45KB/s，115MB 的包要四十多分钟；
#    docker 走 registry 镜像一分钟能拉完。
# 2. alpine 自带的 rust 编不出这个工程。apk 那份 rust 只装 x86_64-alpine-linux-musl
#    一份标准库，编 proc-macro 依赖（displaydoc 之类）时直接报
#    "cannot produce proc-macro ... does not support these crate types"。
#    「在 alpine 里 cargo build」这条路是死的，不是慢。
# 3. 所以：宿主已经装好 x86_64-unknown-linux-musl target 的 rustup 工具链挂进 ubuntu
#    容器，C 编译器与 musl 的 crt/libc 由容器里的 musl-gcc 提供。rusqlite 是 bundled，
#    它的 cc 调用也必须走 musl-gcc —— 这就是 CC_*/AR_* 那几行的用处。
#
# 两条不能省的编译参数：
#   -C target-feature=+crt-static   不加的话 rustc 默认出 static-pie，file 会显示
#                                   "dynamically linked, interpreter /lib/ld-musl-x86_64.so.1"，
#                                   在 Rocky / Debian 上直接 "No such file or directory"
#                                   （那边没有 musl 的加载器）。看着编好了，其实只在
#                                   Alpine 上能跑。
#   -C relocation-model=static      配合上一条消掉 PT_INTERP，出真正不依赖加载器的可执行文件。
set -eu

REPO_RUST="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO_RUST/Cargo.toml" ] || { echo "找不到 $REPO_RUST/Cargo.toml" >&2; exit 2; }

VERSION=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_RUST/Cargo.toml" | head -1)
[ -n "$VERSION" ] || { echo "没能从 Cargo.toml 读出版本号" >&2; exit 2; }

TARGET=x86_64-unknown-linux-musl
TARGET_ENV=$(printf '%s' "$TARGET" | tr 'a-z-' 'A-Z_')
OUT_DIR=${OUT_DIR:-$REPO_RUST/dist}
IMAGE=${IMAGE:-dsh-relay-static-musl-builder}
RUSTUP_HOME_DIR=${RUSTUP_HOME:-$HOME/.rustup}
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
DEB_MIRROR=${DEB_MIRROR:-mirrors.aliyun.com}

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "要 docker（工具链全在容器里）"

# 宿主 rustup 工具链里必须已经有这个 target 的标准库；容器只挂进去用，不负责装。
# 机器上常常装了两三条工具链（旧的那条一般没加 musl target），所以逐条找而不是拿第一条硬碰。
# RUSTUP_TOOLCHAIN 可以直接指定要哪一条。
TC_DIR=""
if [ -n "${RUSTUP_TOOLCHAIN:-}" ] && [ -d "$RUSTUP_HOME_DIR/toolchains/${RUSTUP_TOOLCHAIN}/lib/rustlib/$TARGET/lib" ]; then
    TC_DIR="$RUSTUP_HOME_DIR/toolchains/${RUSTUP_TOOLCHAIN}"
else
    for d in $(sed -n 's/^default_toolchain[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$RUSTUP_HOME_DIR/settings.toml" 2>/dev/null) \
             $(ls -d "$RUSTUP_HOME_DIR"/toolchains/*linux-gnu 2>/dev/null); do
        [ -d "$d/lib/rustlib/$TARGET/lib" ] || continue
        TC_DIR="$d"
        break
    done
fi
[ -n "$TC_DIR" ] || die "没有哪条 rustup 工具链带 $TARGET 的标准库，先跑：rustup target add $TARGET"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    say "构建编译镜像 $IMAGE（一次性，之后复用）"
    CTX=$(mktemp -d /tmp/dsh-relay-image-XXXXXX)
    cat > "$CTX/Dockerfile" <<EOF
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
# musl-tools 给的是 musl-gcc：gcc 加一套 musl 的 specs，不用另拉交叉工具链。
RUN sed -i "s#archive.ubuntu.com#$DEB_MIRROR#g; s#security.ubuntu.com#$DEB_MIRROR#g" /etc/apt/sources.list \\
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
    build-essential musl-tools ca-certificates curl git file binutils > /dev/null \\
 && musl-gcc --version | head -1
EOF
    docker build -f "$CTX/Dockerfile" -t "$IMAGE" "$CTX" >/dev/null || { rm -rf "$CTX"; die "镜像构建失败"; }
    rm -rf "$CTX"
fi

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
STAGE=$(mktemp -d /tmp/dsh-relay-static-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT INT TERM

say "编译 dsh-relay $VERSION（$TARGET，静态）"
# 源码只读挂载、容器内再拷一份到 /work 编：不往仓库里写 target/，只读源码树也照样能编。
# /src 挂的是 server 这一层（`relay` 与它引用的 `relay-core` 的公共父目录），
# 这样容器里是 /work/relay/rust 与 /work/relay-core/rust，相对路径引用照样成立。
docker run --rm --network host \
    -v "$REPO_RUST/../..:/src:ro" \
    -v "$TC_DIR:/rusttc:ro" \
    -v "$CARGO_HOME_DIR:/cargo" \
    -v "$STAGE:/out" \
    -e PATH=/rusttc/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -e CARGO_HOME=/cargo \
    -e "CC_${TARGET_ENV}=musl-gcc" \
    -e "AR_${TARGET_ENV}=ar" \
    -e "CARGO_TARGET_${TARGET_ENV}_LINKER=musl-gcc" \
    -e RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=static" \
    -w / \
    "$IMAGE" \
    sh -c "mkdir -p /work && cp -a /src/. /work/ && cd /work/relay/rust \
        && cargo build --release --target $TARGET 2>&1 | tail -4 \
        && cp target/$TARGET/release/dsh-relay /out/dsh-relay" || die "编译失败"

BIN="$STAGE/dsh-relay"
[ -f "$BIN" ] || die "没有产物"

say "验静态"
file "$BIN"
file "$BIN" | grep -q 'statically linked' || die "file 没说 statically linked"
ldd "$BIN" 2>&1 | grep -q 'not a dynamic executable' || die "ldd 说它不是纯静态（大概是 static-pie）"
if readelf -l "$BIN" 2>/dev/null | grep -q INTERP; then
    die "产物里有 PT_INTERP，在 Rocky / Debian 上会因为找不到 /lib/ld-musl-*.so.1 而跑不起来"
fi

# 内置版本串必须和 Cargo.toml 一致：deploy/publish-relay-update.sh 靠它做发布一致性校验，
# 对不上会让开了自动更新的中转每天升降一次。
BIN_VERSION=$(strings "$BIN" | grep -o '"version":"[0-9]\+\.[0-9]\+\.[0-9]\+"' | head -1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
[ "$BIN_VERSION" = "$VERSION" ] || die "二进制内置版本是 '$BIN_VERSION'，与 Cargo.toml 的 $VERSION 不符"

DEST="$OUT_DIR/dsh-relay-$VERSION"
cp -f "$BIN" "$DEST"
chmod 755 "$DEST"

say "产物 $DEST"
sha256sum "$DEST"
