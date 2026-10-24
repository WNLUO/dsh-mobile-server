# Alpine 3.20 / OpenRC 部署件（无 systemd 的机器用这套）。
#
# 已验证的机器：47.108.201.215（Alpine 3.20.9，OpenRC 0.54）。
#
#   dsh-relay.initd         → /etc/init.d/dsh-relay        (0755)
#   dsh-relay.confd         → /etc/conf.d/dsh-relay        (0644)
#   dsh-relay.env           → /etc/dsh-relay.env          (0600)
#   dsh-relay-log-rotate    → /etc/periodic/daily/         (0755)
#                             并在 /etc/periodic/hourly/ 也挂一份（符号链接即可）：
#                             ln -s /etc/periodic/daily/dsh-relay-log-rotate \
#                                   /etc/periodic/hourly/dsh-relay-log-rotate
#
# 日志为什么要 daily + hourly 都挂：脚本按 relay.log 自己的大小判断（20MiB 才切），
# 只挂 daily 的话每天 02:00 才检查一次，两次检查之间日志能长到任意大小——20MiB
# 只是「下限」，不是上限。挂到 hourly 之后最坏情况才是 20MiB + 一小时增量。
# 另外它**不看磁盘余量**：别的进程把盘写满时它一个字节都不会动，别指望它救场。
#
# 二进制与数据目录（不在这个目录里，由部署方放）：
#
#   /opt/dsh-relay/dsh-relay           二进制（静态 musl 包；自动更新会替换它）
#   /opt/dsh-relay/dsh-relay.previous  上一版（自动更新时留下，回滚的唯一依据，约 8MiB 常驻）
#   /opt/dsh-relay/data/               升级状态（.update-state）等
#   /opt/dsh-relay/logs/relay.log      日志（追加写，按大小自行切分）
#
# 磁盘占用的最坏情况（2 核 431MB 那台实测口径）：
#
#   exe 8 + previous 8 + 日志 4 份 × 20 = 96MiB 稳态；
#   更新瞬间多一份 8MiB 暂存（峰值约 24MiB 的二进制部分）；
#   回滚之后还会多一份 dsh-relay.failed 的 8MiB（下次回滚时才清）。
