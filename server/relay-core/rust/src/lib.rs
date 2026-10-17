//! DSH 隧道协议 v2 —— Rust 实现。
//!
//! 线格式与 `../protocol-types.js` 定义的一致：
//!
//! ```text
//! [type: 1B][id: 4B 大端][length: 4B 大端][payload: length B]
//! ```
//!
//! 这个 crate 只做字节，不碰网络。它的正确性由两件事保证：
//! 一是类型表与 JS 版同源（`protocol-types.js` 是事实源），
//! 二是 `tests/parity.rs` 用同一批输入与 JS 实现逐字节对撞。

/// 帧头长度：type 1B + id 4B + length 4B。
pub const HEADER_LEN: usize = 9;

/// WS 关闭帧 reason 上限 123 字节（RFC 6455 控制帧 125 字节减去 2 字节 code）。
pub const MAX_CLOSE_REASON_BYTES: usize = 123;

/// 帧类型编号。**这里的数字必须和 `protocol-types.js` 的 `T` 表一字不差。**
pub mod t {
    pub const REGISTER: u8 = 0x01;
    pub const REGISTERED: u8 = 0x02;
    pub const UPDATE_PAIRING: u8 = 0x03;
    pub const HTTP_REQUEST: u8 = 0x04;
    pub const HTTP_BODY: u8 = 0x05;
    pub const HTTP_HEAD: u8 = 0x06;
    pub const HTTP_CHUNK: u8 = 0x07;
    pub const HTTP_END: u8 = 0x08;
    pub const HTTP_ERROR: u8 = 0x09;
    pub const WS_UPGRADE: u8 = 0x0A;
    pub const WS_OPEN: u8 = 0x0B;
    pub const WS_ERROR: u8 = 0x0C;
    pub const WS_TEXT: u8 = 0x0D;
    pub const WS_BINARY: u8 = 0x0E;
    pub const WS_CLOSE: u8 = 0x0F;
    pub const PING: u8 = 0x10;
    pub const PONG: u8 = 0x11;
    pub const PAIR_REQUEST: u8 = 0x12;
    pub const PAIR_CONFIRM: u8 = 0x13;
    pub const HTTP_CANCEL: u8 = 0x14;
    pub const HTTP_PAUSE: u8 = 0x15;
    pub const HTTP_RESUME: u8 = 0x16;
    pub const SYNC: u8 = 0x17;
    pub const REVOKE_ALL: u8 = 0x18;
    pub const REVOKE_ALL_ACK: u8 = 0x19;

    /// 编号 → 名字，用于日志与排错。与 JS 侧 `TYPE_NAME` 对应。
    pub fn name(code: u8) -> Option<&'static str> {
        Some(match code {
            REGISTER => "register",
            REGISTERED => "registered",
            UPDATE_PAIRING => "updatePairing",
            HTTP_REQUEST => "httpRequest",
            HTTP_BODY => "httpBody",
            HTTP_HEAD => "httpHead",
            HTTP_CHUNK => "httpChunk",
            HTTP_END => "httpEnd",
            HTTP_ERROR => "httpError",
            WS_UPGRADE => "wsUpgrade",
            WS_OPEN => "wsOpen",
            WS_ERROR => "wsError",
            WS_TEXT => "wsText",
            WS_BINARY => "wsBinary",
            WS_CLOSE => "wsClose",
            PING => "ping",
            PONG => "pong",
            PAIR_REQUEST => "pairRequest",
            PAIR_CONFIRM => "pairConfirm",
            HTTP_CANCEL => "httpCancel",
            HTTP_PAUSE => "httpPause",
            HTTP_RESUME => "httpResume",
            SYNC => "sync",
            REVOKE_ALL => "revokeAll",
            REVOKE_ALL_ACK => "revokeAllAck",
            _ => return None,
        })
    }
}

/// 1005/1006/1015 是保留值，不得出现在线上；1004 语义不明。
const RESERVED_CLOSE_CODES: [u16; 4] = [1004, 1005, 1006, 1015];

/// close code 是否可出现在线上（与 JS 的 `validCloseCode` 同判据）。
pub fn valid_close_code(code: u16) -> bool {
    (1000..=4999).contains(&code) && !RESERVED_CLOSE_CODES.contains(&code)
}

/// 一帧的载荷。控制帧是 JSON/空，数据通道是原始字节。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// 原始字节（httpBody / httpChunk / wsText / wsBinary）。
    Bytes(Vec<u8>),
    /// 已经是序列化好的 JSON 文本（控制帧）。
    Json(String),
    /// 没有载荷。
    Empty,
}

impl Payload {
    fn encoded_len(&self) -> usize {
        match self {
            Payload::Bytes(bytes) => bytes.len(),
            Payload::Json(text) => text.len(),
            Payload::Empty => 0,
        }
    }

    fn write_to(&self, out: &mut [u8]) {
        match self {
            Payload::Bytes(bytes) => out.copy_from_slice(bytes),
            Payload::Json(text) => out.copy_from_slice(text.as_bytes()),
            Payload::Empty => {}
        }
    }
}

/// 编码一帧。行为对齐 JS 侧 `encodeFrame`：头 9 字节 + 原样载荷。
pub fn encode_frame(frame_type: u8, id: u32, payload: &Payload) -> Vec<u8> {
    let body_len = payload.encoded_len();
    let mut out = vec![0u8; HEADER_LEN + body_len];
    out[0] = frame_type;
    out[1..5].copy_from_slice(&id.to_be_bytes());
    out[5..9].copy_from_slice(&(body_len as u32).to_be_bytes());
    payload.write_to(&mut out[HEADER_LEN..]);
    out
}

/// 一个解码出来的帧。`payload` 是切片，用完即弃。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame<'a> {
    pub frame_type: u8,
    pub id: u32,
    pub payload: &'a [u8],
}

impl<'a> Frame<'a> {
    /// 把载荷按 UTF-8 JSON 文本取出来（控制帧用）。
    pub fn payload_str(&self) -> Option<&'a str> {
        std::str::from_utf8(self.payload).ok()
    }
}

/// 流式帧解码器。
///
/// 对齐 JS 侧 `createFrameDecoder`：WS 消息可能包含多帧或半帧，这里做拼接。
/// 超过 `max_frame_bytes` 判定为错误并清空缓冲（与 JS 一致：不崩，报错后重置）。
pub struct FrameDecoder {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

/// 解码器的一次推进结果。
#[derive(Debug, PartialEq, Eq)]
pub enum DecodeOutcome {
    /// 正常处理完了所有完整帧。
    Ok,
    /// 帧过大，缓冲已清空，调用方应关闭连接。
    FrameTooLarge,
}

impl FrameDecoder {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
        }
    }

    /// 喂入一段字节；每解出一帧就回调一次。
    ///
    /// 回调返回的切片指向内部缓冲，调用方**不能**在回调之外保留它。
    pub fn push<F>(&mut self, chunk: &[u8], mut on_frame: F) -> DecodeOutcome
    where
        F: FnMut(Frame<'_>),
    {
        // 与 JS 同判据：一段超出上限，或累积超出上限，都算帧过大。
        if chunk.len() > self.max_frame_bytes + HEADER_LEN
            || self.buffer.len() + chunk.len() > self.max_frame_bytes + HEADER_LEN
        {
            self.buffer.clear();
            return DecodeOutcome::FrameTooLarge;
        }
        self.buffer.extend_from_slice(chunk);

        let mut offset = 0usize;
        while self.buffer.len() - offset >= HEADER_LEN {
            let frame_type = self.buffer[offset];
            let id = u32::from_be_bytes([
                self.buffer[offset + 1],
                self.buffer[offset + 2],
                self.buffer[offset + 3],
                self.buffer[offset + 4],
            ]);
            let len = u32::from_be_bytes([
                self.buffer[offset + 5],
                self.buffer[offset + 6],
                self.buffer[offset + 7],
                self.buffer[offset + 8],
            ]) as usize;

            if len > self.max_frame_bytes {
                self.buffer.clear();
                return DecodeOutcome::FrameTooLarge;
            }
            if self.buffer.len() - offset < HEADER_LEN + len {
                break; // 半帧，等下一次 push
            }
            let start = offset + HEADER_LEN;
            let end = start + len;
            on_frame(Frame {
                frame_type,
                id,
                payload: &self.buffer[start..end],
            });
            offset = end;
        }
        if offset > 0 {
            self.buffer.drain(..offset);
        }
        DecodeOutcome::Ok
    }

    /// 当前缓冲里还剩多少字节（半帧）。
    pub fn pending_len(&self) -> usize {
        self.buffer.len()
    }
}

/// 按字节截断字符串，且不切断 UTF-8 码点。
///
/// 对齐 JS 侧 `truncateUtf8`：找不到完整码点就退到上一个字符边界。
pub fn truncate_utf8(text: &str, max_bytes: usize) -> &[u8] {
    let bytes = text.as_bytes();
    if bytes.len() <= max_bytes {
        return bytes;
    }
    let mut end = max_bytes;
    while end > 0 {
        // 若 end 落在字符边界上，直接可用。
        if text.is_char_boundary(end) {
            return &bytes[..end];
        }
        end -= 1;
    }
    &[]
}

/// 编码 wsClose 载荷：2B 大端 close code + 不切断码点的 UTF-8 reason。
///
/// 非法 code 一律降级成 1000，与 JS 侧一致。
pub fn encode_close_payload(code: u16, reason: &str) -> Vec<u8> {
    let safe_code = if valid_close_code(code) { code } else { 1000 };
    let truncated = truncate_utf8(reason, MAX_CLOSE_REASON_BYTES);
    let mut out = Vec::with_capacity(2 + truncated.len());
    out.extend_from_slice(&safe_code.to_be_bytes());
    out.extend_from_slice(truncated);
    out
}

/// 解码 wsClose 载荷。返回 (交付给 ws.close 的 code, 线上原值, 是否合法, reason)。
pub fn decode_close_payload(payload: &[u8]) -> (u16, u16, bool, String) {
    let raw = if payload.len() >= 2 {
        u16::from_be_bytes([payload[0], payload[1]])
    } else {
        1000
    };
    let ok = valid_close_code(raw);
    let reason = if payload.len() > 2 {
        let bytes = &payload[2..];
        // 与 JS 一样按 UTF-8 解码；非法字节序列退化成空串而不是 panic。
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        String::new()
    };
    (if ok { raw } else { 1000 }, raw, ok, reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_nine_bytes_big_endian() {
        let frame = encode_frame(t::HTTP_CHUNK, 259, &Payload::Bytes(vec![1, 2, 3]));
        assert_eq!(frame[0], t::HTTP_CHUNK);
        assert_eq!(&frame[1..5], &[0, 0, 1, 3]);
        assert_eq!(&frame[5..9], &[0, 0, 0, 3]);
        assert_eq!(&frame[9..], &[1, 2, 3]);
    }

    #[test]
    fn empty_payload_has_zero_length() {
        let frame = encode_frame(t::PING, 0, &Payload::Empty);
        assert_eq!(frame.len(), HEADER_LEN);
        assert_eq!(&frame[5..9], &[0, 0, 0, 0]);
    }

    #[test]
    fn decoder_handles_half_frame_then_completes() {
        let frame = encode_frame(t::HTTP_END, 7, &Payload::Empty);
        let mut decoder = FrameDecoder::new(1024);
        let mut seen = Vec::new();
        decoder.push(&frame[..4], |f| seen.push((f.frame_type, f.id)));
        assert!(seen.is_empty(), "半帧不该解出来");
        decoder.push(&frame[4..], |f| seen.push((f.frame_type, f.id)));
        assert_eq!(seen, vec![(t::HTTP_END, 7)]);
    }

    #[test]
    fn decoder_handles_coalesced_frames() {
        let mut data = encode_frame(t::PING, 0, &Payload::Empty);
        data.extend(encode_frame(t::PONG, 0, &Payload::Empty));
        let mut decoder = FrameDecoder::new(1024);
        let mut seen = Vec::new();
        decoder.push(&data, |f| seen.push(f.frame_type));
        assert_eq!(seen, vec![t::PING, t::PONG]);
    }

    #[test]
    fn oversized_frame_is_rejected_and_buffer_cleared() {
        let mut decoder = FrameDecoder::new(8);
        let data = vec![0u8; 64];
        assert_eq!(decoder.push(&data, |_| {}), DecodeOutcome::FrameTooLarge);
        assert_eq!(decoder.pending_len(), 0);
    }

    #[test]
    fn reserved_close_codes_fall_back_to_1000() {
        for code in [1004u16, 1005, 1006, 1015, 999, 5000] {
            assert_eq!(decode_close_payload(&encode_close_payload(code, "x")).0, 1000, "code {code}");
        }
        assert_eq!(decode_close_payload(&encode_close_payload(1001, "bye")).0, 1001);
    }

    #[test]
    fn close_reason_is_truncated_without_splitting_a_codepoint() {
        let reason = "超长的中文原因".repeat(20);
        let encoded = encode_close_payload(1000, &reason);
        let body = &encoded[2..];
        assert!(body.len() <= MAX_CLOSE_REASON_BYTES);
        // 必须是合法 UTF-8（截断没切坏码点）。
        assert!(std::str::from_utf8(body).is_ok());
    }

    #[test]
    fn every_type_has_a_name() {
        for code in 0x01..=0x19u8 {
            assert!(t::name(code).is_some(), "{code:#04x} 没有名字");
        }
    }
}
