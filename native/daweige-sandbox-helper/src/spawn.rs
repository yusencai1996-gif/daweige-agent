//! 受限进程启动+输出管道(一期)——CreateProcessAsUserW + 匿名管道 stdio + Job 树管理。
//! Adapted from OpenAI Codex windows-sandbox-rs process.rs(Apache-2.0):
//! 管道 stdio/CREATE_NO_WINDOW/环境块大写排序的形态同源;等待循环与超时取消为本仓窄化实现。

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::sync::mpsc;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, ResumeThread, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
    STARTUPINFOW,
};

pub struct SpawnConfig {
    pub id: u32,
    /// 命令原文(交给 powershell -Command,本函数负责引用)。
    pub command: String,
    pub cwd: String,
    pub timeout_ms: u32,
    pub env: std::collections::BTreeMap<String, String>,
}

pub struct SpawnResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// 输出回调:(is_stderr, sequence, chunk)。
pub type OutputSink<'a> = &'a mut dyn FnMut(bool, u32, Vec<u8>);

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// PowerShell -Command 的 argv 引用:Windows 标准双引号包裹+内部双引号转义。
/// 单引号包法会把整条命令当字符串字面量回显(实测坑);双引号经 CRT 拆参后
/// -Command 拿到原文,由 PS 按脚本执行,命令语义零改写。
pub fn quote_ps(command: &str) -> String {
    format!("\"{}\"", command.replace('"', "\\\""))
}

/// 环境块(UTF-16,键大写排序,\0\0 结尾);helper 侧剔除密钥类变量兜底。
pub fn make_env_block(env: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
    const FORBIDDEN_PREFIXES: &[&str] = &[
        "KIMI", "ZAI", "DEEPSEEK", "ANTHROPIC", "OPENAI", "DAWEIGE", "ELECTRON",
    ];
    let mut items: Vec<(&String, &String)> = env
        .iter()
        .filter(|(k, _)| {
            let upper = k.to_uppercase();
            !FORBIDDEN_PREFIXES.iter().any(|p| upper.starts_with(p))
        })
        .collect();
    items.sort_by(|a, b| a.0.to_uppercase().cmp(&b.0.to_uppercase()));
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in items {
        block.extend(format!("{}={}", k, v).encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

struct PipePair {
    read_end: HANDLE,
    write_end: HANDLE,
}

impl PipePair {
    unsafe fn new() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::SetHandleInformation;
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        const HANDLE_FLAG_INHERIT: u32 = 0x1;
        let mut read_end: HANDLE = std::ptr::null_mut();
        let mut write_end: HANDLE = std::ptr::null_mut();
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        if CreatePipe(&mut read_end, &mut write_end, &sa, 0) == 0 {
            return Err("CreatePipe 失败".into());
        }
        // 父读端去掉继承(子进程只该拿到写端)
        SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0);
        Ok(PipePair { read_end, write_end })
    }
}

/// 启动一次受限命令并等待完成;输出经回调实时上抛。
pub unsafe fn spawn_and_wait(
    token: HANDLE,
    cfg: &SpawnConfig,
    on_output: OutputSink,
) -> Result<SpawnResult, String> {
    let out_pipe = PipePair::new()?;
    let err_pipe = PipePair::new()?;

    let cmdline = format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -Command {}",
        quote_ps(&cfg.command)
    );
    let mut cmdline_w = to_wide(&cmdline);
    let cwd_w = to_wide(&cfg.cwd);
    let env_block = make_env_block(&cfg.env);

    let mut si = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES,
        hStdInput: std::ptr::null_mut(),
        hStdOutput: out_pipe.write_end,
        hStdError: err_pipe.write_end,
        ..std::mem::zeroed()
    };
    let mut pi = PROCESS_INFORMATION::default();

    let created = CreateProcessAsUserW(
        token,
        std::ptr::null(),
        cmdline_w.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        1, // bInheritHandles:管道写端要继承
        CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        env_block.as_ptr() as *const c_void,
        cwd_w.as_ptr(),
        &mut si,
        &mut pi,
    );
    if created == 0 {
        use windows_sys::Win32::Foundation::GetLastError;
        let err = GetLastError();
        for h in [out_pipe.read_end, out_pipe.write_end, err_pipe.read_end, err_pipe.write_end] {
            CloseHandle(h);
        }
        return Err(format!("创建沙箱进程失败(系统拒绝,错误码 {})", err));
    }

    // Job:整棵进程树,KILL_ON_JOB_CLOSE(父/子退出都不留孙进程)
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        terminate_suspended(&mut pi);
        return Err("创建 Job 失败".into());
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    ) == 0
        || AssignProcessToJobObject(job, pi.hProcess) == 0
    {
        terminate_suspended(&mut pi);
        CloseHandle(job);
        return Err("进程挂 Job 失败".into());
    }

    // 父侧关闭写端(否则读不到 EOF);恢复主线程(挂起创建保证进 Job 前不逃逸)
    CloseHandle(out_pipe.write_end);
    CloseHandle(err_pipe.write_end);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    // 输出读取:两条线程 → channel 汇聚 → 主循环回调(帧编码在上层串行做)
    let (tx, rx) = mpsc::channel::<(bool, u32, Vec<u8>)>();
    // HANDLE 裸指针非 Send:按 usize 转移到读线程(句柄在父进程内全局有效)
    let readers: Vec<(usize, bool)> = vec![
        (out_pipe.read_end as usize, false),
        (err_pipe.read_end as usize, true),
    ];
    let handles: Vec<std::thread::JoinHandle<()>> = readers
        .into_iter()
        .map(|(read_end_raw, is_stderr)| {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let read_end = read_end_raw as HANDLE;
                unsafe { pump_pipe(read_end, is_stderr, &tx) };
            })
        })
        .collect();
    drop(tx); // 读线程持各自的 sender;主循环 drop 自己的副本后 recv 自然结束

    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(cfg.timeout_ms as u64);
    let mut timed_out = false;
    loop {
        // 排空输出
        while let Ok((is_stderr, seq, chunk)) = rx.try_recv() {
            on_output(is_stderr, seq, chunk);
        }
        let waited = WaitForSingleObject(pi.hProcess, 50);
        if waited == WAIT_OBJECT_0 {
            // 进程退出:把尾部输出读完(线程遇 EOF 自然结束)
            while let Ok((is_stderr, seq, chunk)) = rx.try_recv() {
                on_output(is_stderr, seq, chunk);
            }
            for h in handles {
                let _ = h.join();
            }
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1);
            let _ = WaitForSingleObject(pi.hProcess, 5_000);
            while let Ok((is_stderr, seq, chunk)) = rx.try_recv() {
                on_output(is_stderr, seq, chunk);
            }
            for h in handles {
                let _ = h.join();
            }
            break;
        }
    }

    let mut exit_code: u32 = 0;
    windows_sys::Win32::System::Threading::GetExitCodeProcess(pi.hProcess, &mut exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(job);
    CloseHandle(out_pipe.read_end);
    CloseHandle(err_pipe.read_end);

    Ok(SpawnResult {
        exit_code: if timed_out { None } else { Some(exit_code as i32) },
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

unsafe fn terminate_suspended(pi: &mut PROCESS_INFORMATION) {
    windows_sys::Win32::System::Threading::TerminateProcess(pi.hProcess, 1);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
}

/// 阻塞读管道直到 EOF,逐块送 channel。
unsafe fn pump_pipe(read_end: HANDLE, is_stderr: bool, tx: &mpsc::Sender<(bool, u32, Vec<u8>)>) {
    let mut seq = 0u32;
    let mut buf = [0u8; 16 * 1024];
    loop {
        let mut read: u32 = 0;
        let ok = ReadFile(
            read_end,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut read,
            std::ptr::null_mut(), // 同步读,无 OVERLAPPED
        );
        if ok == 0 || read == 0 {
            break;
        }
        if tx.send((is_stderr, seq, buf[..read as usize].to_vec())).is_err() {
            break; // 接收端走了(主进程退出)
        }
        seq += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_quoting() {
        assert_eq!(quote_ps("Get-ChildItem"), "\"Get-ChildItem\"");
        assert_eq!(quote_ps("echo \"hi\""), "\"echo \\\"hi\\\"\"");
        assert_eq!(quote_ps("echo 'hi'"), "\"echo 'hi'\"");
    }

    #[test]
    fn env_block_filters_and_sorts() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("ZAI_API_KEY".to_string(), "secret".into());
        env.insert("zzVar".to_string(), "1".into());
        env.insert("APath".to_string(), "x".into());
        let block = make_env_block(&env);
        let text: String = encode_utf16_lossy(&block);
        assert!(!text.contains("ZAI_API_KEY"));
        assert!(text.contains("APath=x"));
        assert!(text.contains("zzVar=1"));
        // APath 排在 zzVar 前
        assert!(text.find("APath=").unwrap() < text.find("zzVar=").unwrap());
    }

    fn encode_utf16_lossy(block: &[u16]) -> String {
        String::from_utf16_lossy(&block[..block.len().saturating_sub(1)])
    }
}
