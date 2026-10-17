#!/bin/sh
# 中转控制台数据库的每日备份。
#
# 库文件是这台中转唯一的运营资产：用户、激活码、设备绑定、被控端记录全在里面。
# 丢了就是全部重来，所以必须自动化、必须有保留份数、必须验过能恢复。
#
# 用 sqlite3 的 `.backup` 而不是直接拷文件：WAL 模式下裸拷 .db 会漏掉还没 checkpoint
# 的页，拷出来可能是个坏库。`.backup` 是 SQLite 官方的在线备份接口，会自己处理这个。
#
# 保留 30 份，按日期命名，越旧的越早删。
set -eu

DB=/opt/dsh-mobile/data/console.db
OUT=/opt/dsh-mobile/backups
KEEP=30

mkdir -p "$OUT"

STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="$OUT/console-$STAMP.db"

sqlite3 "$DB" ".backup '$TARGET'"
gzip -f "$TARGET"

# 备份完立刻验一遍：能打开、关键表在、行数非空。备份脚本安静地产生坏文件，
# 比没有备份更危险——有人以为自己在保险箱里。
VERIFY=$(mktemp)
gunzip -c "$TARGET.gz" > "$VERIFY"
USERS=$(sqlite3 "$VERIFY" "SELECT count(*) FROM users;" 2>/dev/null || echo "")
SCHEMA=$(sqlite3 "$VERIFY" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "")
rm -f "$VERIFY"
if [ -z "$USERS" ] || [ -z "$SCHEMA" ] || [ "$SCHEMA" -lt 5 ]; then
    echo "$(date -Iseconds) 备份校验失败：users=$USERS tables=$SCHEMA" >&2
    rm -f "$TARGET.gz"
    exit 1
fi

# 只留最近 KEEP 份。
ls -1t "$OUT"/console-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
done

echo "$(date -Iseconds) 备份完成 $(basename "$TARGET").gz users=$USERS tables=$SCHEMA 保留 $KEEP 份"
