//! 跨语言逐字节对撞：Rust 实现与 JS 权威实现必须对同一输入编出**完全相同**的字节。
//!
//! 测试运行时调用 Node 执行本仓 `../test/protocol.js`，使用其实际编码字节作为参照，
//! 与 Rust 实现逐帧比对。中转仓库的 CI 安装 Node 与 Rust 工具链。

use std::process::Command;

use dsh_relay_protocol::{encode_close_payload, encode_frame, t, Payload};

/// JS 对照实现位于 relay-core 的测试夹具目录；本仓库独立构建，不依赖插件仓库检出。
const JS_PROTOCOL: &str = "../test/protocol.js";
const JS_TYPES: &str = "../protocol-types.js";

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 调 node 跑一段脚本，返回它 stdout 的 JSON。
fn run_node(script: &str) -> Option<String> {
    let dir = std::env::current_dir().ok()?;
    let proto = dir.join(JS_PROTOCOL);
    let types = dir.join(JS_TYPES);
    let prelude = format!(
        "const p = require({});\nconst t = require({});\n",
        serde_quote(proto.to_str()?),
        serde_quote(types.to_str()?)
    );
    let output = Command::new("node")
        .arg("-e")
        .arg(format!("{prelude}{script}"))
        .output()
        .ok()?;
    if !output.status.success() {
        // JS 参照实现缺失或无法执行时，让对撞测试明确失败。
        panic!(
            "JS 实现跑不起来（{}）：{}",
            JS_PROTOCOL,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 把路径包成一个 JS 字符串字面量（避免 Windows 反斜杠等转义问题）。
fn serde_quote(path: &str) -> String {
    let escaped = path.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

/// 从 JS 返回的字节数组文本（`[1,2,3]`）解析成 Vec<u8>。
fn parse_byte_array(text: &str) -> Option<Vec<u8>> {
    let inner = text.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    inner
        .split(',')
        .map(|part| part.trim().parse::<u8>().ok())
        .collect()
}

#[test]
fn encode_frame_matches_js_byte_for_byte() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    let cases: &[(&str, u8)] = &[
        ("register", t::REGISTER),
        ("registered", t::REGISTERED),
        ("httpRequest", t::HTTP_REQUEST),
        ("httpBody", t::HTTP_BODY),
        ("httpHead", t::HTTP_HEAD),
        ("httpChunk", t::HTTP_CHUNK),
        ("httpEnd", t::HTTP_END),
        ("httpError", t::HTTP_ERROR),
        ("wsUpgrade", t::WS_UPGRADE),
        ("wsOpen", t::WS_OPEN),
        ("wsError", t::WS_ERROR),
        ("wsText", t::WS_TEXT),
        ("wsBinary", t::WS_BINARY),
        ("wsClose", t::WS_CLOSE),
        ("ping", t::PING),
        ("pong", t::PONG),
        ("pairRequest", t::PAIR_REQUEST),
        ("pairConfirm", t::PAIR_CONFIRM),
        ("httpCancel", t::HTTP_CANCEL),
        ("httpPause", t::HTTP_PAUSE),
        ("httpResume", t::HTTP_RESUME),
        ("sync", t::SYNC),
        ("revokeAll", t::REVOKE_ALL),
        ("revokeAllAck", t::REVOKE_ALL_ACK),
    ];

    for (name, code) in cases {
        // 每个帧名都用 JS 自己查出来的编号再确认一次，防止 Rust 常量抄错。
        let script = format!("const f = p.encodeFrame(t.T['{name}'], 0x01020304, Buffer.from('协议parity')); console.log(JSON.stringify([...f]));");
        let Some(js_bytes) = run_node(&script) else {
            return;
        };
        let expected = parse_byte_array(&js_bytes).expect("解析 JS 字节失败");
        let actual = encode_frame(*code, 0x01020304, &Payload::Bytes("协议parity".as_bytes().to_vec()));
        assert_eq!(actual, expected, "{name} 的编码与 JS 不一致");
    }
}

#[test]
fn empty_payload_matches_js() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    for (name, code) in [("ping", t::PING), ("pong", t::PONG), ("httpEnd", t::HTTP_END)] {
        let script = format!("const f = p.encodeFrame(t.T['{name}'], 0, null); console.log(JSON.stringify([...f]));");
        let Some(js_bytes) = run_node(&script) else { return };
        assert_eq!(
            encode_frame(code, 0, &Payload::Empty),
            parse_byte_array(&js_bytes).expect("解析失败"),
            "{name} 的空载荷编码与 JS 不一致"
        );
    }
}

#[test]
fn close_payload_matches_js() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    let cases: &[(u16, &str)] = &[
        (1000, "normal"),
        (1001, "bye"),
        (1006, "reserved"),
        (999, "below"),
        (5000, "above"),
        (1001, "超长的中文原因超长的中文原因超长的中文原因超长的中文原因"),
    ];
    for (code, reason) in cases {
        let script = format!(
            "console.log(JSON.stringify([...p.encodeClosePayload({code}, {} )]))",
            serde_quote(reason)
        );
        let Some(js_bytes) = run_node(&script) else { return };
        assert_eq!(
            encode_close_payload(*code, reason),
            parse_byte_array(&js_bytes).expect("解析失败"),
            "close({code}) 与 JS 不一致"
        );
    }
}

#[test]
fn type_table_matches_js() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    let script = "console.log(JSON.stringify(Object.entries(t.T).sort((a,b)=>a[1]-b[1])))";
    let Some(json) = run_node(script) else { return };
    // 逐个名字确认 Rust 常量与 JS 表一致。
    let pairs: &[(&str, u8)] = &[
        ("register", t::REGISTER),
        ("registered", t::REGISTERED),
        ("updatePairing", t::UPDATE_PAIRING),
        ("httpRequest", t::HTTP_REQUEST),
        ("httpBody", t::HTTP_BODY),
        ("httpHead", t::HTTP_HEAD),
        ("httpChunk", t::HTTP_CHUNK),
        ("httpEnd", t::HTTP_END),
        ("httpError", t::HTTP_ERROR),
        ("wsUpgrade", t::WS_UPGRADE),
        ("wsOpen", t::WS_OPEN),
        ("wsError", t::WS_ERROR),
        ("wsText", t::WS_TEXT),
        ("wsBinary", t::WS_BINARY),
        ("wsClose", t::WS_CLOSE),
        ("ping", t::PING),
        ("pong", t::PONG),
        ("pairRequest", t::PAIR_REQUEST),
        ("pairConfirm", t::PAIR_CONFIRM),
        ("httpCancel", t::HTTP_CANCEL),
        ("httpPause", t::HTTP_PAUSE),
        ("httpResume", t::HTTP_RESUME),
        ("sync", t::SYNC),
        ("revokeAll", t::REVOKE_ALL),
        ("revokeAllAck", t::REVOKE_ALL_ACK),
    ];
    for (name, code) in pairs {
        assert!(
            json.contains(&format!("[\"{name}\",{}]", *code)),
            "{name} 的编号与 JS 表不一致（Rust 侧是 {code}）"
        );
    }
}
