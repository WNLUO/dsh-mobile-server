# 中转的海外更新源

这个目录里只有一份 `latest.json`，**二进制不在这里**——它挂在同版本的 Release 资产上
（`rust-v<版本>`）。8MB 的包每次发布都进 git 历史的话，几年下来仓库就没法 clone 了。

`latest.json` 里的 `url` 直接指向
`https://github.com/WNLUO/dsh-mobile-server/releases/download/rust-v<版本>/dsh-relay-<版本>`。

用途：海外节点的 `SELF_UPDATE_SOURCE` 指向这个分支的 raw 地址
（`https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/relay-updates/relay-updates`）。
法兰克福那台实测从这里取 8MB 约 0.9 秒；反过来从国内更新源取要 15 秒左右。

为什么单独一个分支、不放 main：这个文件每次发布都会被改一行，而 main 上是源码。混在
一起会让「发版」变成「往主分支上提交一个数据文件」，review 和冲突都没意义。

发布时怎么更新它：`deploy/publish-relay-update.sh` 传
`RELAY_UPDATE_EXTRA_ROOTS=@github RELAY_UPDATE_EXTRA_BASES=... RELAY_UPDATE_GITHUB_REPO=WNLUO/dsh-mobile-server`
会生成一份指向 Release 资产的清单到 `/tmp/dsh-relay-gh-manifest/latest.json`，
把它提交到这个分支即可。脚本不替人 push——发布这种事不该由一个改文件名的脚本顺手做掉。
