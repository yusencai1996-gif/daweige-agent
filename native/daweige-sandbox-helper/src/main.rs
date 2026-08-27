//! daweige-sandbox-helper——大微阁沙箱命令执行器(0.4.0 C2)。
//! 一期:Restricted Token(读全盘/写仅授权根);网络未隔离(诚实口径)。
//! 主进程(Node)是唯一驱动方:stdin 收帧、stdout 回帧;任何协议错→fail-closed 退出。
//!
//! 接线状态(0.4.0 C2):Spawn = 令牌(token.rs)+ 写根授权(acl.rs)+ 受限进程(spawn.rs)。
//! capability SID 由 host 在 Spawn 帧 env 的内部键 `DWG_CAP_SID` 传入
//! (一期简化:cap store 归 host 管理,helper 无状态;该键不进子进程环境)。

mod acl;
mod frame;
mod spawn;
mod token;

use std::io::{Read, Write};

use base64::Engine;
use frame::{decode_frame, encode_frame, HelperFrame, HostFrame, Stream};
use spawn::SpawnConfig;

const PROTOCOL_VERSION: u32 = 1;
/// capability SID 的内部传递键(make_env_block 剔除 DWG 前缀,不进子进程)。
const CAP_SID_ENV_KEY: &str = "DWG_CAP_SID";

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    // 握手:就绪即报版本
    write_frame(&mut writer, &HelperFrame::Ready { version: PROTOCOL_VERSION });

    loop {
        let Some(frame) = read_frame(&mut reader) else {
            // EOF(主进程退出)或协议错:静默终止,不留半进程
            break;
        };
        match frame {
            HostFrame::Shutdown => break,
            HostFrame::Spawn { id, command, cwd, timeout_ms, writable_roots, mut env } => {
                let cap_sid = match env.remove(CAP_SID_ENV_KEY) {
                    Some(s) if s.starts_with("S-1-5-80-") => s,
                    _ => {
                        // fail-closed:没有合法 capability SID,拒绝运行
                        write_frame(
                            &mut writer,
                            &HelperFrame::Error {
                                id: Some(id),
                                message: "沙箱授权信息缺失或不合法,这条命令不会运行".into(),
                            },
                        );
                        continue;
                    }
                };
                let outcome = run_spawned(
                    id,
                    &command,
                    &cwd,
                    timeout_ms,
                    &writable_roots,
                    &env,
                    &cap_sid,
                    &mut writer,
                );
                match outcome {
                    Ok(outcome) => {
                        write_frame(
                            &mut writer,
                            &HelperFrame::SpawnExited {
                                id,
                                exit_code: outcome.exit_code,
                                timed_out: outcome.timed_out,
                                cancelled: false,
                                duration_ms: outcome.duration_ms,
                            },
                        );
                    }
                    Err(message) => {
                        write_frame(&mut writer, &HelperFrame::Error { id: Some(id), message });
                    }
                }
            }
            HostFrame::Cancel { id } => {
                // 一期单命令串行:当前 spawn 的等待循环在超时/退出后自然收尾;
                // 独立多命令与主动 KillJob 在 C5 合流批补,先幂等确认。
                write_frame(
                    &mut writer,
                    &HelperFrame::SpawnExited {
                        id,
                        exit_code: None,
                        timed_out: false,
                        cancelled: true,
                        duration_ms: 0,
                    },
                );
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_spawned(
    id: u32,
    command: &str,
    cwd: &str,
    timeout_ms: u32,
    writable_roots: &[String],
    env: &std::collections::BTreeMap<String, String>,
    cap_sid: &str,
    writer: &mut impl Write,
) -> Result<spawn::SpawnResult, String> {
    unsafe {
        // 1) 受限令牌
        let (base, restricted) = token::build_restricted_token(cap_sid)?;

        // 2) 写根挂钥匙孔(幂等;不动既有 ACE)
        let cap_bytes = token::sid_from_sddl(cap_sid)?;
        for root in writable_roots {
            acl::grant_write_access(root, &cap_bytes)?;
        }

        // 3) 启动+等待;输出实时回帧(Base64,stdout/stderr 各自计数)
        let cfg = SpawnConfig {
            id,
            command: command.to_string(),
            cwd: cwd.to_string(),
            timeout_ms,
            env: env.clone(),
        };
        let mut seq_stdout: u32 = 0;
        let mut seq_stderr: u32 = 0;
        let result = spawn::spawn_and_wait(restricted, &cfg, &mut |is_stderr, _seq, chunk| {
            let (stream, sequence) = if is_stderr {
                let s = seq_stderr;
                seq_stderr += 1;
                (Stream::Stderr, s)
            } else {
                let s = seq_stdout;
                seq_stdout += 1;
                (Stream::Stdout, s)
            };
            let frame = HelperFrame::Output {
                id,
                stream,
                sequence,
                data_b64: base64::engine::general_purpose::STANDARD.encode(&chunk),
            };
            write_frame(writer, &frame);
        });

        if !restricted.is_null() {
            windows_sys::Win32::Foundation::CloseHandle(restricted);
        }
        if !base.is_null() {
            windows_sys::Win32::Foundation::CloseHandle(base);
        }
        result
    }
}

fn write_frame(writer: &mut impl Write, frame: &HelperFrame) {
    let buf = encode_frame(frame);
    if writer.write_all(&buf).and_then(|_| writer.flush()).is_err() {
        std::process::exit(0);
    }
}

fn read_frame(reader: &mut impl Read) -> Option<HostFrame> {
    let mut len_buf = [0u8; 4];
    if reader.read_exact(&mut len_buf).is_err() {
        return None;
    }
    let len = u32::from_le_bytes(len_buf);
    if len > frame::MAX_FRAME_BYTES {
        return None;
    }
    let mut payload = vec![0u8; len as usize];
    if reader.read_exact(&mut payload).is_err() {
        return None;
    }
    serde_json::from_slice(&payload).ok()
}
