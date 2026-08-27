//! 受限令牌(一期)——按 Codex windows-sandbox-rs 的 token.rs 蓝本窄化实现。
//! Adapted from OpenAI Codex windows-sandbox-rs (Apache-2.0):
//! flags 组合(DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED)、restricting SIDs
//! 顺序(Capabilities..., ExtraRestricting..., Logon, Everyone)、TOKEN_GROUPS 手工对齐解析均同源。
//!
//! 安全语义:读保持当前用户能力(一期读全盘口径);写必须命中 ACL 上 capability SID 的
//! allow-write ACE(WRITE_RESTRICTED 令牌的双重写检查)。不申请提权、不弹 UAC。

#![allow(non_snake_case)]

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, GENERIC_ALL, HANDLE, HLOCAL, LocalFree, LUID};
use windows_sys::Win32::Security::{
    CopySid, CreateRestrictedToken, GetTokenInformation, GetLengthSid, SetTokenInformation,
    AdjustTokenPrivileges, LookupPrivilegeValueW,
    DISABLE_MAX_PRIVILEGE, LUA_TOKEN, WRITE_RESTRICTED,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY, TokenGroups, TokenDefaultDacl,
    ACL, SID_AND_ATTRIBUTES, TOKEN_PRIVILEGES,
};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// 蓝本同源常量(windows-sys 未导出)。
const SE_GROUP_LOGON_ID: u32 = 0xC0000000;

// windows-sys 未导出的 API,蓝本同款手动声明。
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(ProcessHandle: HANDLE, DesiredAccess: u32, TokenHandle: *mut HANDLE) -> i32;
    fn ConvertStringSidToSidW(StringSid: *const u16, Sid: *mut *mut std::ffi::c_void) -> i32;
    fn ConvertSidToStringSidW(Sid: *const std::ffi::c_void, StringSid: *mut *mut u16) -> i32;
}

/// Caller must close the returned token handle. (蓝本同源)
pub unsafe fn get_current_token_for_restriction() -> Result<HANDLE, String> {
    let desired = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut h: HANDLE = std::ptr::null_mut();
    let ok = OpenProcessToken(GetCurrentProcess(), desired, &mut h);
    if ok == 0 {
        return Err(format!("OpenProcessToken failed: {}", GetLastError()));
    }
    Ok(h)
}

/// 从 token 的 groups 里取 Logon SID(蓝本同源:TOKEN_GROUPS 手工对齐解析)。
pub unsafe fn get_logon_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>, String> {
    let mut needed: u32 = 0;
    GetTokenInformation(h_token, TokenGroups, std::ptr::null_mut(), 0, &mut needed);
    if needed == 0 {
        return Err("GetTokenInformation 长度探测失败".into());
    }
    let mut buf: Vec<u8> = vec![0u8; needed as usize];
    let ok = GetTokenInformation(
        h_token,
        TokenGroups,
        buf.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    );
    if ok == 0 || (needed as usize) < std::mem::size_of::<u32>() {
        return Err("GetTokenInformation 读取失败".into());
    }
    let group_count = std::ptr::read_unaligned(buf.as_ptr() as *const u32) as usize;
    // TOKEN_GROUPS 布局:DWORD GroupCount; SID_AND_ATTRIBUTES Groups[](64 位下按指针对齐)
    let after_count = buf.as_ptr().add(std::mem::size_of::<u32>()) as usize;
    let align = std::mem::align_of::<usize>();
    let aligned = (after_count + (align - 1)) & !(align - 1);
    let groups_ptr = aligned as *const SID_AND_ATTRIBUTES;
    for i in 0..group_count {
        let entry = std::ptr::read_unaligned(groups_ptr.add(i));
        if (entry.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID {
            let sid = entry.Sid;
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return Err("Logon SID 长度未知".into());
            }
            let mut out = vec![0u8; sid_len as usize];
            if CopySid(sid_len, out.as_mut_ptr() as *mut c_void, sid) == 0 {
                return Err("CopySid 失败".into());
            }
            return Ok(out);
        }
    }
    Err("token 里没有 Logon SID".into())
}

/// Everyone (S-1-1-0) SID,caller 负责 LocalFree。(蓝本同源)
pub unsafe fn world_sid() -> Result<Vec<u8>, String> {
    let sddl: Vec<u16> = "S-1-1-0\0".encode_utf16().collect();
    let mut psid: *mut c_void = std::ptr::null_mut();
    if ConvertStringSidToSidW(sddl.as_ptr(), &mut psid) == 0 {
        return Err(format!("ConvertStringSidToSidW failed: {}", GetLastError()));
    }
    let len = GetLengthSid(psid);
    let mut out = vec![0u8; len as usize];
    let copied = CopySid(len, out.as_mut_ptr() as *mut c_void, psid);
    LocalFree(psid as HLOCAL);
    if copied == 0 {
        return Err("CopySid(Everyone) 失败".into());
    }
    Ok(out)
}

/// 任意 SDDL 形态 SID(capability 由 host 以 S-1-5-80-... 机器 SID 形态传入),caller 免释放(值拷贝)。
pub unsafe fn sid_from_sddl(sddl: &str) -> Result<Vec<u8>, String> {
    let wide: Vec<u16> = format!("{}\0", sddl).encode_utf16().collect();
    let mut psid: *mut c_void = std::ptr::null_mut();
    if ConvertStringSidToSidW(wide.as_ptr(), &mut psid) == 0 {
        return Err(format!("SID 解析失败: {}", sddl));
    }
    let len = GetLengthSid(psid);
    let mut out = vec![0u8; len as usize];
    let copied = CopySid(len, out.as_mut_ptr() as *mut c_void, psid);
    LocalFree(psid as HLOCAL);
    if copied == 0 {
        return Err("CopySid 失败".into());
    }
    Ok(out)
}

/// SID → SDDL 字符串(诊断/cap store 记录用)。
pub unsafe fn sid_to_sddl(sid_bytes: &[u8]) -> Result<String, String> {
    let psid = sid_bytes.as_ptr() as *const c_void;
    let mut out: *mut u16 = std::ptr::null_mut();
    if ConvertSidToStringSidW(psid, &mut out) == 0 {
        return Err("ConvertSidToStringSidW failed".into());
    }
    let mut s = String::new();
    let mut i = 0usize;
    loop {
        let ch = *out.add(i);
        if ch == 0 {
            break;
        }
        s.push(char::from_u32(ch as u32).unwrap_or('?'));
        i += 1;
    }
    LocalFree(out as HLOCAL);
    Ok(s)
}

/// SID 字节长度(Revision + SubAuthorityCount*4 + 固定头 8)。
pub fn sid_byte_length(sid: &[u8]) -> usize {
    if sid.len() < 8 {
        return sid.len();
    }
    8 + sid[1] as usize * 4  // 布局:Revision(1B)+SubAuthorityCount(1B)+IdentifierAuthority(6B)+子授权(4B each)
}

/// 构造受限令牌:restricting = [capability..., logon, everyone](蓝本顺序同源,去掉蓝本的路由身份 extras)。
/// 返回 HANDLE,caller 必须 CloseHandle。
pub unsafe fn create_restricted_token(
    base_token: HANDLE,
    capability_sids: &[Vec<u8>],
) -> Result<HANDLE, String> {
    if capability_sids.is_empty() {
        return Err("capability SIDs 为空,拒绝创建非受限令牌".into());
    }
    let logon = get_logon_sid_bytes(base_token)?;
    let everyone = world_sid()?;

    // 拷贝到稳定的内存(构造期间指针必须有效)
    let mut owned: Vec<Vec<u8>> = Vec::with_capacity(capability_sids.len() + 2);
    owned.extend(capability_sids.iter().cloned());
    owned.push(logon);
    owned.push(everyone);

    let mut entries: Vec<SID_AND_ATTRIBUTES> = Vec::with_capacity(owned.len());
    for bytes in &owned {
        entries.push(SID_AND_ATTRIBUTES {
            Sid: bytes.as_ptr() as *mut c_void,
            Attributes: 0,
        });
    }

    let mut new_token: HANDLE = std::ptr::null_mut();
    let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    let ok = CreateRestrictedToken(
        base_token,
        flags,
        0,
        std::ptr::null(),
        0,
        std::ptr::null(),
        entries.len() as u32,
        entries.as_mut_ptr(),
        &mut new_token,
    );
    if ok == 0 {
        return Err(format!("CreateRestrictedToken failed: {}", GetLastError()));
    }

    // 蓝本同源两步(缺了 PowerShell 会 STATUS_DLL_INIT_FAILED):
    // ① 默认 DACL 放行 logon/everyone/capability(受限进程建命名对象/管道需要)
    let mut dacl_sids: Vec<*mut c_void> = Vec::with_capacity(owned.len());
    for bytes in &owned {
        dacl_sids.push(bytes.as_ptr() as *mut c_void);
    }
    set_default_dacl(new_token, &dacl_sids)?;
    // ② SeChangeNotifyPrivilege(目录遍历;剥光特权后单独放回这一个)
    enable_single_privilege(new_token, "SeChangeNotifyPrivilege")?;

    Ok(new_token)
}

/// 蓝本同源:把 sids 写进 token 的默认 DACL(GENERIC_ALL,新建命名对象可用)。
unsafe fn set_default_dacl(h_token: HANDLE, sids: &[*mut c_void]) -> Result<(), String> {
    if sids.is_empty() {
        return Ok(());
    }
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect();
    let mut p_new_dacl: *mut ACL = std::ptr::null_mut();
    let res = SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), std::ptr::null_mut(), &mut p_new_dacl);
    if res != 0 {
        return Err(format!("SetEntriesInAclW(default dacl) failed: {}", res));
    }
    #[repr(C)]
    struct TokenDefaultDaclInfo {
        default_dacl: *mut ACL,
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: p_new_dacl };
    let ok = SetTokenInformation(
        h_token,
        TokenDefaultDacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
    );
    if !p_new_dacl.is_null() {
        LocalFree(p_new_dacl as HLOCAL);
    }
    if ok == 0 {
        return Err(format!("SetTokenInformation(TokenDefaultDacl) failed: {}", GetLastError()));
    }
    Ok(())
}

/// 蓝本同源:单独启用一个特权(SeChangeNotifyPrivilege)。
unsafe fn enable_single_privilege(h_token: HANDLE, name: &str) -> Result<(), String> {
    let mut luid = LUID { LowPart: 0, HighPart: 0 };
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    if LookupPrivilegeValueW(std::ptr::null(), wide.as_ptr(), &mut luid) == 0 {
        return Err(format!("LookupPrivilegeValueW failed: {}", GetLastError()));
    }
    let mut tp: TOKEN_PRIVILEGES = std::mem::zeroed();
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Luid = luid;
    tp.Privileges[0].Attributes = 0x0000_0002; // SE_PRIVILEGE_ENABLED
    if AdjustTokenPrivileges(h_token, 0, &tp as *const _ as *const TOKEN_PRIVILEGES, 0, std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
        return Err(format!("AdjustTokenPrivileges failed: {}", GetLastError()));
    }
    Ok(())
}

/// 便捷入口:当前进程令牌 + 单 capability → 受限令牌(测试与 spawn 用)。
pub unsafe fn build_restricted_token(capability_sddl: &str) -> Result<(HANDLE, HANDLE), String> {
    let base = get_current_token_for_restriction()?;
    let cap = sid_from_sddl(capability_sddl)?;
    match create_restricted_token(base, &[cap]) {
        Ok(h) => Ok((base, h)),
        Err(e) => {
            CloseHandle(base);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_sid_shape() {
        unsafe {
            let sid = world_sid().unwrap();
            // S-1-1-0:Revision=1,SubAuthorityCount=1 → 长度 8+4=12
            assert_eq!(sid[0], 1);
            assert_eq!(sid_byte_length(&sid), sid.len());
            assert_eq!(sid_byte_length(&sid), 12);
            let sddl = sid_to_sddl(&sid).unwrap();
            assert_eq!(sddl, "S-1-1-0");
        }
    }

    #[test]
    fn capability_sddl_roundtrip() {
        unsafe {
            let sddl = "S-1-5-80-3059226430-2429028250-3884687754-2528706751-3767272719";
            let sid = sid_from_sddl(sddl).unwrap();
            assert_eq!(sid_to_sddl(&sid).unwrap(), sddl);
            assert_eq!(sid_byte_length(&sid), sid.len());
        }
    }

    #[test]
    #[ignore = "需要真实进程令牌环境(开发机跑:npm run sandbox:test)"]
    fn restricted_token_constructs() {
        unsafe {
            let (base, restricted) = build_restricted_token("S-1-5-80-1234567890-1234567890-1234567890-1234567890-1234567890").unwrap();
            assert!(!restricted.is_null());
            CloseHandle(restricted);
            CloseHandle(base);
        }
    }
}
