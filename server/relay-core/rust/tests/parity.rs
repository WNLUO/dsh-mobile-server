//! 跨语言逐字节对撞：Rust 实现与 JS 权威实现必须对同一输入编出**完全相同**的字节。
//! blob 协商、旧控制帧及同 type/id 双向分片回执共用现有线格式。
//!
//! 测试运行时调用 Node 执行本仓 `../test/protocol.js`，使用其实际编码字节作为参照，
//! 与 Rust 实现逐帧比对。中转仓库的 CI 安装 Node 与 Rust 工具链。

use std::process::Command;

use dsh_relay_protocol::{encode_close_payload, encode_frame, t, DecodeOutcome, FrameDecoder, Payload};

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
        ("pushRegister", t::PUSH_REGISTER),
        ("pushSend", t::PUSH_SEND),
        ("blobPut", t::BLOB_PUT),
        ("blobDelete", t::BLOB_DELETE),
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
fn reference_type_table_matches_js_source() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    let script = "const entries = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); console.log(entries(p.T) === entries(t.T));";
    let text = run_node(script).expect("读取 JS 参考帧表失败");
    assert_eq!(text, "true", "参考宿主帧表必须与事实源逐项相等");
}

#[test]
fn blob_upload_frames_match_js_byte_for_byte() {
    assert!(
        node_available(),
        "本机没有 node，跨语言对撞无法进行——这组测试存在的意义就是它真的跑了"
    );
    let cases: &[(&str, &str, u8, u32, &str)] = &[
        ("旧注册回执", "registered", t::REGISTERED, 0, r#"{"ok":true,"mirror":false}"#),
        ("分片能力", "registered", t::REGISTERED, 0, r#"{"ok":true,"mirror":false,"blobUpload":{"maxChunkBytes":49152,"maxBlobBytes":5242880}}"#),
        ("旧整包", "blobPut", t::BLOB_PUT, 0, r#"{"scope":"messages","key":"会话","creds":[{"hash":"0000000000000000000000000000000000000000000000000000000000000000","expiresAt":0}],"cipher":"AAEC_w"}"#),
        ("旧凭据刷新", "blobPut", t::BLOB_PUT, 0, r#"{"scope":"messages","key":"会话","creds":[{"hash":"0000000000000000000000000000000000000000000000000000000000000000","expiresAt":0}],"cipher":""}"#),
        ("首片", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"scope":"messages","key":"会话","creds":[{"hash":"0000000000000000000000000000000000000000000000000000000000000000","expiresAt":0}],"offset":0,"total":8,"final":false,"cipher":"AAEC"}"#),
        ("首片回执", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"ok":true,"nextOffset":3,"done":false}"#),
        ("续片", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"offset":3,"total":8,"final":false,"cipher":"AwQF"}"#),
        ("续片回执", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"ok":true,"nextOffset":6,"done":false}"#),
        ("尾片", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"offset":6,"total":8,"final":true,"cipher":"Bgc"}"#),
        ("发布回执", "blobPut", t::BLOB_PUT, 0x01020304, r#"{"ok":true,"nextOffset":8,"done":true}"#),
        ("失败回执", "blobPut", t::BLOB_PUT, u32::MAX, r#"{"ok":false,"nextOffset":0,"done":false,"error":"写入失败"}"#),
    ];
    let mut rust_stream = Vec::new();
    let mut js_frames = Vec::new();
    for (label, name, code, id, json) in cases {
        let script = format!(
            "const payload = JSON.parse({}); const frame = p.jsonFrame(p.T['{name}'], {id}, payload); console.log(JSON.stringify([...frame]));",
            serde_quote(json)
        );
        let js_bytes = run_node(&script).expect("编码 JS blob 帧失败");
        let expected = parse_byte_array(&js_bytes).expect("解析 JS blob 帧失败");
        let actual = encode_frame(*code, *id, &Payload::Json((*json).to_string()));
        assert_eq!(actual, expected, "{label} 的编码与 JS 不一致");
        rust_stream.extend_from_slice(&actual);
        js_frames.push(format!("p.jsonFrame(p.T['{name}'], {id}, JSON.parse({}))", serde_quote(json)));
    }

    // 请求与反向回执同 type/id，编解码必须保留每条 JSON，不得按 id 合并。
    let mut decoder = FrameDecoder::new(rust_stream.len());
    let mut decoded = Vec::new();
    let mut decode = |frame: dsh_relay_protocol::Frame<'_>| {
        decoded.push((frame.frame_type, frame.id, frame.payload.to_vec()));
    };
    assert_eq!(decoder.push(&rust_stream[..7], &mut decode), DecodeOutcome::Ok);
    assert_eq!(decoder.push(&rust_stream[7..], &mut decode), DecodeOutcome::Ok);
    assert_eq!(decoder.pending_len(), 0);
    let expected: Vec<_> = cases.iter()
        .map(|(_, _, code, id, json)| (*code, *id, json.as_bytes().to_vec()))
        .collect();
    assert_eq!(decoded, expected, "同 type/id 的双向 blob 帧必须逐帧保留");

    let script = format!(
        "const decoded = []; const push = p.createFrameDecoder(frame => decoded.push([frame.type, frame.id, [...frame.payload]])); const wire = Buffer.concat([{}]); push(wire.subarray(0, 7)); push(wire.subarray(7)); console.log(JSON.stringify(decoded));",
        js_frames.join(",")
    );
    let js_decoded = run_node(&script).expect("解码 JS blob 帧失败");
    let rust_decoded = format!("[{}]", decoded.iter().map(|(code, id, payload)| {
        format!("[{code},{id},[{}]]", payload.iter().map(u8::to_string).collect::<Vec<_>>().join(","))
    }).collect::<Vec<_>>().join(","));
    assert_eq!(js_decoded, rust_decoded, "blob 帧的流式解码与 JS 不一致");
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
    // 两边**集合相等**：JS 表里多一个、少一个、或者名字/编号对不上都要红。
    // 早先是拿每个名字去 JS 输出里找子串，漂移不会红——漏掉的帧根本没人查，
    // 而漏掉一帧就是一条静默不通的路径。
    let script = "for (const [name, code] of Object.entries(t.T)) console.log(name + ' ' + code)";
    let Some(text) = run_node(script) else { return };
    let mut js: Vec<(String, u8)> = text
        .lines()
        .filter_map(|line| {
            let (name, code) = line.split_once(' ')?;
            Some((name.to_string(), code.trim().parse::<u8>().ok()?))
        })
        .collect();
    js.sort();

    let mut rust: Vec<(String, u8)> = [
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
        ("pushRegister", t::PUSH_REGISTER),
        ("pushSend", t::PUSH_SEND),
        ("migrate", t::MIGRATE),
        ("blobPut", t::BLOB_PUT),
        ("blobDelete", t::BLOB_DELETE),
    ]
    .iter()
    .map(|(name, code)| (name.to_string(), *code))
    .collect();
    rust.sort();

    assert_eq!(rust, js, "帧表两边必须逐条相等（名字与编号都对得上）");
}
