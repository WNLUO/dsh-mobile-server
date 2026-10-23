# Alpine 3.20 / OpenRC 部署件（无 systemd 的机器用这套）。
#
# 已验证的机器：47.108.201.215（Alpine 3.20.9，OpenRC 0.54）。
#
#   dsh-relay.initd         → /etc/init.d/dsh-relay        (0755)
#   dsh-relay.confd         → /etc/conf.d/dsh-relay        (0644)
#   dsh-relay.env           → /etc/dsh-relay.env          (0600)
#   dsh-relay-log-rotate    → /etc/periodic/daily/         (0755)
#
# 二进制与数据目录（不在这个目录里，由部署方放）：
#
#   /opt/dsh-relay/dsh-relay        二进制（静态 musl 包；自动更新会替换它）
#   /opt/dsh-relay/data/            升级状态（.update-state）等
#   /opt/dsh-relay/logs/relay.log   日志（追加写，按大小自行切分）
