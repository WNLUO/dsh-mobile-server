//! Workers 版里那些**不依赖 worker 运行时**的逻辑。
//!
//! 这个 crate 的主体是 Durable Object，跑起来要 Cloudflare 环境；能在这里测的是它
//! 赖以工作的协议层与判定规则——那也正是最容易静默出错的地方。

use dsh_relay_protocol::{decode_close_payload, encode_close_payload, encode_frame, t, FrameDecoder, Payload};

#[test]
fn worker_uses_the_shipped_frame_encoding() {
    // Workers 版转发的帧必须和 Node 版一字不差，否则手机与宿主会看到两种字节。
    let frame = encode_frame(t::WS_TEXT, 7, &Payload::Bytes(b"hello".to_vec()));
    assert_eq!(&frame[1..5], &[0, 0, 0, 7]);
    assert_eq!(&frame[5..9], &[0, 0, 0, 5]);
    assert_eq!(&frame[9..], b"hello");
}

#[test]
fn tunnel_frames_decode_across_chunk_boundaries() {
    // Hibernation 恢复了连接，但一次 message 里可能是多帧或半帧。
    let mut data = encode_frame(t::PING, 0, &Payload::Empty);
    data.extend(encode_frame(t::WS_BINARY, 3, &Payload::Bytes(vec![1, 2, 3])));
    let mut decoder = FrameDecoder::new(1024);
    let mut seen = Vec::new();
    decoder.push(&data, |frame| seen.push(frame.frame_type));
    assert_eq!(seen, vec![t::PING, t::WS_BINARY]);
}

#[test]
fn phone_close_payload_round_trips() {
    let payload = encode_close_payload(1001, "client gone");
    let (code, _raw, valid, reason) = decode_close_payload(&payload);
    assert_eq!(code, 1001);
    assert!(valid);
    assert_eq!(reason, "client gone");
}

#[test]
fn invalid_close_code_falls_back() {
    let payload = encode_close_payload(1006, "reserved");
    assert_eq!(decode_close_payload(&payload).0, 1000);
}

#[test]
fn every_frame_type_used_by_the_worker_exists() {
    // Workers 版只处理这几类帧；名字在不在是编译期就定下的，这里钉住它们确实是
    // 协议表里的编号，而不是随手写的数字。
    for name in ["WS_UPGRADE", "WS_TEXT", "WS_BINARY", "WS_CLOSE", "PING", "PONG"] {
        let code = match name {
            "WS_UPGRADE" => t::WS_UPGRADE,
            "WS_TEXT" => t::WS_TEXT,
            "WS_BINARY" => t::WS_BINARY,
            "WS_CLOSE" => t::WS_CLOSE,
            "PING" => t::PING,
            "PONG" => t::PONG,
            _ => unreachable!(),
        };
        assert!(t::name(code).is_some(), "{name} 不在协议表里");
    }
}
