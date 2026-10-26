#!/bin/sh
# 发布一个中转版本：把二进制放进更新源目录，然后写 latest.json。
#
# 用法（在服务器上，二进制已经编好）：
#   ./publish-relay-update.sh <版本> <x86_64 二进制路径> [aarch64 二进制路径]
#
# 例：
#   ./publish-relay-update.sh 0.1.1 /opt/dsh-mobile/build/relay/rust/target/release/dsh-relay
#
# 发到多个更新源（国内一个、海外一个）：
#   RELAY_UPDATE_ROOT=/opt/dsh-mobile/relay-updates \
#   RELAY_UPDATE_PUBLIC_BASE=https://dsh-hub.wnluo.com/relay-updates \
#   RELAY_UPDATE_EXTRA_ROOTS=/mnt/gh/relay-updates \
#   RELAY_UPDATE_EXTRA_BASES=https://raw.githubusercontent.com/…/relay-updates \
#   ./publish-relay-update.sh 0.1.8 /abs/path/dsh-relay-linux-x86_64
# 两个列表按位置一一对应；只给一个就只发一处。海外那台的中转把海外源写在自己
# SELF_UPDATE_SOURCE 里，它不会来国内取。
#
# 先预发、再正式（`RELAY_UPDATE_CHANNEL=canary`）：
#   RELAY_UPDATE_CHANNEL=canary \
#   RELAY_UPDATE_ROOT_CANARY=/opt/dsh-mobile/relay-updates-canary \
#   RELAY_UPDATE_PUBLIC_BASE_CANARY=https://dsh-hub.wnluo.com/relay-updates-canary \
#   ./publish-relay-update.sh 0.1.9 /abs/path/dsh-relay-linux-x86_64 [aarch64 路径]
# canary 目录只有「更新源把 canary 写在最前面」的那台机器会读。它升上去、跑一段、
# 人看过日志与 /status 之后，去掉这两个变量再跑一次同一条命令，才是正式发布。
# 两条通道共用同一份二进制——差别只在清单放在哪个目录。
#
# 目标是 GitHub 时，ROOT 那一项写 `@github`（不是目录）：
#   RELAY_UPDATE_EXTRA_ROOTS=/path/to/repo-checkout/relay-updates\ @github
#   RELAY_UPDATE_EXTRA_BASES=<raw 前缀> <github 前缀>
# 这一路**只写清单、不拷二进制**：二进制挂 Release 资产，清单里的地址直接指向
# `releases/download/rust-v<版本>/<资产名>`。8MB 的包不进 git 历史——每次发布都在
# 仓库里塞一个二进制，几年下来仓库就没法 clone 了。
#
# 做了什么、为什么这么做：
#   1. 先拷二进制、再写清单。反过来会让中转在「清单已更新、文件还没到」的窗口里
#      下到一个 404 或半截文件——那个窗口哪怕只有一秒也不该有。
#   2. 版本号与上一份清单相同就拒绝。重复发布同一个版本号是发布事故的最常见形态：
#      机器上跑的版本没变，问题却以为已经修了。
#   3. 校验和写在清单里，与版本号、地址同一份文件；分成两个文件会有「清单更新了、
#      校验和还是旧的」这种自相矛盾的状态。
set -eu

VERSION=${1:-}
X86=${2:-}
ARM=${3:-}

if [ -z "$VERSION" ] || [ -z "$X86" ]; then
    echo "用法：$0 <版本 X.Y.Z> <x86_64 二进制> [aarch64 二进制]" >&2
    exit 2
fi

printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
    echo "版本号必须是 X.Y.Z，收到：$VERSION" >&2
    exit 2
}

# 更新源的落盘目录与对外地址都由部署方给，**不写死**：这份脚本一旦被抄到别人的机器上，
# 写死的地址会把人家的二进制发布到我们的域名下（或反过来取错地方）。
#
# 两条通道同一套逻辑，区别只在清单落哪个目录：canary 是「先给我们自己的机器升」的那份，
# release 是所有人读的那份。二进制两次发布用的是同一份文件，不做任何重编。
CHANNEL=${RELAY_UPDATE_CHANNEL:-release}
case "$CHANNEL" in
    release)
        ROOT=${RELAY_UPDATE_ROOT:-/opt/dsh-mobile/relay-updates}
        PUBLIC_BASE=${RELAY_UPDATE_PUBLIC_BASE:-}
        BASE_HINT=https://your-domain.example/relay-updates
        ;;
    canary)
        ROOT=${RELAY_UPDATE_ROOT_CANARY:-/opt/dsh-mobile/relay-updates-canary}
        PUBLIC_BASE=${RELAY_UPDATE_PUBLIC_BASE_CANARY:-}
        BASE_HINT=https://your-domain.example/relay-updates-canary
        ;;
    *)
        echo "RELAY_UPDATE_CHANNEL 只能是 release 或 canary，收到：$CHANNEL" >&2
        exit 2
        ;;
esac
if [ -z "$PUBLIC_BASE" ]; then
    if [ "$CHANNEL" = canary ]; then
        echo "请设 RELAY_UPDATE_PUBLIC_BASE_CANARY（例如 $BASE_HINT），" >&2
    else
        echo "请设 RELAY_UPDATE_PUBLIC_BASE（例如 $BASE_HINT），" >&2
    fi
    echo "它是写进 latest.json 的下载地址前缀，必须是一个能从外网取到的真实地址。" >&2
    exit 2
fi
PUBLIC_BASE=${PUBLIC_BASE%/}
EXTRA_ROOTS=${RELAY_UPDATE_EXTRA_ROOTS:-}
EXTRA_BASES=${RELAY_UPDATE_EXTRA_BASES:-}
mkdir -p "$ROOT"
cd "$ROOT"

# 已经在跑的版本不能重复发。
if [ -f latest.json ]; then
    CURRENT=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' latest.json | head -1)
    if [ "$CURRENT" = "$VERSION" ]; then
        echo "latest.json 里已经是 $VERSION，不重复发布" >&2
        exit 1
    fi
fi

# **二进制里烤进去的版本必须和你声明的版本一致。**
#
# 这是自动更新最容易静默失效的地方：`CARGO_PKG_VERSION` 在编译时定死，从 `Cargo.toml`
# 取。忘了抬 `Cargo.toml` 的版本就直接发布，机器升上去之后自报的还是旧版本，下一次检查
# 又认为「该升到新版本」，于是**每天下载、替换、重启一次，永远停不下来**；反过来如果
# 声明得比真实版本低，机器会一直认为自己是新版本，从此再也收不到更新。
# 两种都只在事后从日志里看得出来。所以在发布这一步就拦住。
BIN_VERSION=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' <<EOF_VERSION
$(strings "$X86" 2>/dev/null | grep -o '"version":"[0-9]\+\.[0-9]\+\.[0-9]\+"' | head -1)
EOF_VERSION
)
if [ -z "$BIN_VERSION" ]; then
    echo "警告：没能从 $X86 里读出内置版本号，跳过一致性校验" >&2
elif [ "$BIN_VERSION" != "$VERSION" ]; then
    echo "拒绝发布：二进制内置版本是 $BIN_VERSION，但你声明的是 $VERSION。" >&2
    echo "先把 Cargo.toml 的 version 改成 $VERSION 再重新编译，否则自动更新会反复升降。" >&2
    exit 3
fi

ENTRIES=""
add_arch() {
    arch=$1
    src=$2
    [ -n "$src" ] || return 0
    [ -f "$src" ] || { echo "找不到二进制：$src" >&2; exit 1; }
    dest="dsh-relay-linux-$arch"
    cp -f "$src" "$dest.tmp"
    chmod 755 "$dest.tmp"
    mv -f "$dest.tmp" "$dest"
    hash=$(sha256sum "$dest" | cut -d' ' -f1)
    entry="\"$arch\":{\"url\":\"$PUBLIC_BASE/$dest\",\"sha256\":\"$hash\"}"
    if [ -z "$ENTRIES" ]; then ENTRIES="$entry"; else ENTRIES="$ENTRIES,$entry"; fi
    echo "已放入 $dest（$hash）"
}

add_arch x86_64 "$X86"
add_arch aarch64 "$ARM"

# 清单最后写，且是整个换上去（write + rename），不让中转读到半截 JSON。
printf '{\n  "version": "%s",\n  "binaries": {%s}\n}\n' "$VERSION" "$ENTRIES" > latest.json.tmp
mv -f latest.json.tmp latest.json

# 发完立刻自检：清单能被解析、里面的地址真能取到、取到的字节哈希对得上。
# 发一个自己都下不来的版本，所有开了自动更新的中转会一起失败。
for arch in x86_64 aarch64; do
    url=$(sed -n "s/.*\"$arch\":{\"url\":\"\([^\"]*\)\".*/\1/p" latest.json)
    [ -n "$url" ] || continue
    actual=$(curl -fsS --max-time 60 "$url" | sha256sum | cut -d' ' -f1)
    expect=$(sed -n "s/.*\"$arch\":{\"url\":\"[^\"]*\",\"sha256\":\"\([^\"]*\)\".*/\1/p" latest.json)
    if [ "$actual" != "$expect" ]; then
        echo "自检失败：$arch 下载回来的哈希对不上（期望 $expect，实际 $actual）" >&2
        exit 1
    fi
    echo "自检通过：$arch"
done

# 镜像到其它更新源。**先拷二进制、再拷清单**，顺序和主源一致；每个目标再单独自检
# 一次——一个取不下来的海外源，等于海外那批机器静默停更。
# GitHub 那一路：清单里的地址指向 Release 资产，不拷二进制。
mirror_manifest_only() {
    target_root=$1
    target_base=$2
    repo=$3
    tag="rust-v$VERSION"
    [ -d "$target_root" ] || mkdir -p "$target_root"
    entries=""
    for arch in x86_64 aarch64; do
        # 资产名与更新源里的文件名、与 GitHub Actions 出的包**三处同名**：
        # dsh-relay-linux-<arch>。装、升、人工下载看到的是同一个名字。
        asset="dsh-relay-linux-$arch"
        hash=$(sha256sum "$ROOT/dsh-relay-linux-$arch" 2>/dev/null | cut -d' ' -f1)
        [ -n "$hash" ] || continue
        entry="\"$arch\":{\"url\":\"https://github.com/$repo/releases/download/$tag/$asset\",\"sha256\":\"$hash\"}"
        if [ -z "$entries" ]; then entries="$entry"; else entries="$entries,$entry"; fi
    done
    printf '{\n  "version": "%s",\n  "binaries": {%s}\n}\n' "$VERSION" "$entries" > "$target_root/latest.json.tmp"
    mv -f "$target_root/latest.json.tmp" "$target_root/latest.json"
    # 自检只做「能取到、哈希对得上」；取不到说明 Release 资产还没挂上去或者名字不对。
    for arch in x86_64 aarch64; do
        url=$(sed -n "s/.*\"$arch\":{\"url\":\"\([^\"]*\)\".*/\1/p" "$target_root/latest.json")
        [ -n "$url" ] || continue
        actual=$(curl -fsSL --max-time 180 "$url" | sha256sum | cut -d' ' -f1)
        expect=$(sed -n "s/.*\"$arch\":{\"url\":\"[^\"]*\",\"sha256\":\"\([^\"]*\)\".*/\1/p" "$target_root/latest.json")
        if [ "$actual" != "$expect" ]; then
            echo "GitHub 清单自检失败：$arch 取回来的哈希对不上（$url）" >&2
            echo "先挂 Release 资产再发布清单，或检查资产名。" >&2
            exit 1
        fi
        echo "GitHub 清单自检通过：$arch"
    done
}

mirror_to() {
    target_root=$1
    target_base=$2
    [ -d "$target_root" ] || mkdir -p "$target_root"
    for arch in x86_64 aarch64; do
        src="$ROOT/dsh-relay-linux-$arch"
        [ -f "$src" ] || continue
        cp -f "$src" "$target_root/dsh-relay-linux-$arch.tmp"
        mv -f "$target_root/dsh-relay-linux-$arch.tmp" "$target_root/dsh-relay-linux-$arch"
    done
    sed "s#${PUBLIC_BASE}#${target_base}#g" latest.json > "$target_root/latest.json.tmp"
    mv -f "$target_root/latest.json.tmp" "$target_root/latest.json"
    for arch in x86_64 aarch64; do
        url=$(sed -n "s/.*\"$arch\":{\"url\":\"\([^\"]*\)\".*/\1/p" "$target_root/latest.json")
        [ -n "$url" ] || continue
        actual=$(curl -fsS --max-time 120 "$url" | sha256sum | cut -d' ' -f1)
        expect=$(sed -n "s/.*\"$arch\":{\"url\":\"[^\"]*\",\"sha256\":\"\([^\"]*\)\".*/\1/p" "$target_root/latest.json")
        if [ "$actual" != "$expect" ]; then
            echo "镜像自检失败：$target_base $arch 下载回来的哈希对不上" >&2
            exit 1
        fi
        echo "镜像自检通过：$target_base $arch"
    done
}

# 两个列表按位置配对。数量不一致是配置错误，直接拒绝——宁可发不出去，也不要
# 「二进制发到 A、清单指向 B」。
set -- $EXTRA_ROOTS
extra_root_count=$#
set -- $EXTRA_BASES
extra_base_count=$#
if [ "$extra_root_count" -ne "$extra_base_count" ]; then
    echo "RELAY_UPDATE_EXTRA_ROOTS 与 RELAY_UPDATE_EXTRA_BASES 的数量必须相同" >&2
    exit 2
fi
set -- $EXTRA_ROOTS
for base in $EXTRA_BASES; do
    root=$1
    shift
    if [ "$root" = "@github" ]; then
        echo "镜像清单到 GitHub（$base）"
        mirror_manifest_only /tmp/dsh-relay-gh-manifest "${base%/}" "${RELAY_UPDATE_GITHUB_REPO:?目标为 @github 时必须设 RELAY_UPDATE_GITHUB_REPO（owner/repo）}"
        # 清单本身交给调用方拷进仓库；脚本只管生成，不猜仓库在哪。
        echo "清单已生成：/tmp/dsh-relay-gh-manifest/latest.json（要提交到仓库的 relay-updates/ 下）"
    else
        echo "镜像到 $base（$root）"
        mirror_to "$root" "${base%/}"
    fi
done

echo "已发布 $VERSION（$CHANNEL）：$ROOT/latest.json"
if [ "$CHANNEL" = canary ]; then
    echo "预发通道：只有把 $PUBLIC_BASE 写在 SELF_UPDATE_SOURCE 最前面的那台会升。"
    echo "跑一段、看过日志与 /status 之后，去掉 RELAY_UPDATE_CHANNEL 再跑一次同一条命令发正式。"
fi
