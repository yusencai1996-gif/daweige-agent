//! 帧协议 v1(与 Electron 主进程 sandbox-process-host 对齐):
//! 4 字节小端长度 + UTF-8 JSON;帧上限 4 MiB(输出 chunk 分帧)。
//! Adapted from OpenAI Codex ipc_framed 协议形状(Apache-2.0,仅借帧设计,实现独立)。

use serde::{Deserialize, Serialize};

/// 协议帧上限(字节)。超过直接判协议错误,防恶意长度字段撑爆内存。
pub const MAX_FRAME_BYTES: u32 = 4 * 1024 * 1024;

/// 主进程 → helper
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostFrame {
    /// 启动一次命令(spawn)。file 即待执行的 helper 目标命令原文(PowerShell -Command 形态由 Node 侧拼好)。
    Spawn {
        id: u32,
        /// argv[0] 固定为 powershell.exe(由 host 校验路径与参数形状;helper 不接受任意程序)。
        command: String,
        cwd: String,
        timeout_ms: u32,
        /// 授权写根(capability ACL 已在 spawn 前就位;helper 只信任传入快照)。
        writable_roots: Vec<String>,
        /// 环境白名单(由 helper 二次过滤,剔除一切 provider key/测试变量)。
        env: std::collections::BTreeMap<String, String>,
    },
    /// 取消:杀整棵 Job 进程树。
    Cancel { id: u32 },
    /// 关闭会话:排空后退出。
    Shutdown,
}

/// helper → 主进程
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperFrame {
    /// 就绪握手(版本与能力)。
    Ready { version: u32 },
    SpawnStarted { id: u32 },
    /// 输出增量(stdout/stderr 各自维护 sequence)。
    Output {
        id: u32,
        stream: Stream,
        sequence: u32,
        /// 二进制安全:Base64(UTF-8 文本也走 Base64,Node 侧统一 decode)。
        data_b64: String,
    },
    SpawnExited {
        id: u32,
        exit_code: Option<i32>,
        timed_out: bool,
        cancelled: bool,
        duration_ms: u64,
    },
    /// 协议/执行器级错误(不暴露内部路径细节)。
    Error { id: Option<u32>, message: String },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// 编码一帧:length prefix(小端 u32)+ JSON。
pub fn encode_frame(frame: &impl Serialize) -> Vec<u8> {
    let payload = serde_json::to_vec(frame).expect("帧序列化不会失败");
    let len = u32::try_from(payload.len()).expect("帧长度超 u32");
    let mut buf = Vec::with_capacity(payload.len() + 4);
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(&payload);
    buf
}

/// 解码一帧(输入为完整帧:前 4 字节长度+payload)。
pub fn decode_frame(bytes: &[u8]) -> Result<HelperFrame, String> {
    if bytes.len() < 4 {
        return Err("帧不完整".into());
    }
    let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if len > MAX_FRAME_BYTES {
        return Err(format!("帧长度 {} 超上限", len));
    }
    let payload = &bytes[4..4 + len as usize];
    serde_json::from_slice(payload).map_err(|e| format!("帧 JSON 解析失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn roundtrip_spawn() {
        let mut env = BTreeMap::new();
        env.insert("SystemRoot".to_string(), "C:\\Windows".to_string());
        let f = HostFrame::Spawn {
            id: 7,
            command: "Get-ChildItem".into(),
            cwd: "D:\\work".into(),
            timeout_ms: 120_000,
            writable_roots: vec!["D:\\work".into()],
            env,
        };
        let buf = encode_frame(&f);
        let back: HostFrame = serde_json::from_slice(&buf[4..]).unwrap();
        assert_eq!(back, f);
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(len + 4, buf.len());
    }

    #[test]
    fn roundtrip_output_base64() {
        let f = HelperFrame::Output {
            id: 1,
            stream: Stream::Stdout,
            sequence: 3,
            data_b64: "5L2g5aW9".into(),
        };
        let buf = encode_frame(&f);
        let back = decode_frame(&buf).unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn oversize_frame_rejected() {
        let mut buf = (MAX_FRAME_BYTES + 1).to_le_bytes().to_vec();
        buf.extend_from_slice(b"{}");
        assert!(decode_frame(&buf).is_err());
    }

    #[test]
    fn incomplete_frame_rejected() {
        assert!(decode_frame(&[1, 2]).is_err());
    }

    #[test]
    fn unknown_frame_type_rejected() {
        let payload = br#"{"type":"definitely_not_real"}"#;
        let mut buf = (payload.len() as u32).to_le_bytes().to_vec();
        buf.extend_from_slice(payload);
        // HostFrame 与 HelperFrame 是两个方向;decode 只认 HelperFrame
        assert!(decode_frame(&buf).is_err());
    }
}
