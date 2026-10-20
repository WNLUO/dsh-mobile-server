# relay-core — 中转协议

`protocol-types.js` 定义帧编号和路径规则；`rust/` 实现相同协议的字节编解码，供 `../relay/rust/` 按路径依赖。桌面插件是单独发布的包，内联自己的协议实现，不能从这里运行时加载代码。

帧头为 1 字节类型、4 字节大端请求号和 4 字节大端载荷长度。线格式与各帧说明见 [PROTOCOL.md](PROTOCOL.md)。

`test/protocol.js` 是对撞和端到端测试使用的 JS 协议副本。改动帧编号或字节格式时，同步更新桌面插件的内联副本，并运行：

```sh
npm run test:relay-core
npm run test:relay
npm run build:relay && npm run test:e2e
```

Rust 编解码与 JS 副本比的是实际产出的字节，不比源码文本。
