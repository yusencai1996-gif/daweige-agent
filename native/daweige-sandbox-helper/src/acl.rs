//! 写根授权(一期)——给 capability SID 在目录上挂 allow-write 继承 ACE。
//! Adapted from OpenAI Codex windows-sandbox-rs acl.rs(Apache-2.0):
//! SetEntriesInAclW + EXPLICIT_ACCESS_W/TRUSTEE_IS_SID 的合成路径同源;此处窄化为单条授权。
//!
//! 语义:不动用户既有 ACE(追加而非重建);幂等(已有等价 ACE 跳过)。
//! 该 ACE 是"锁的钥匙孔",真正的锁在 WRITE_RESTRICTED 令牌的双重写检查。

#![allow(non_snake_case)]

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LocalFree, HLOCAL};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, GetAce,
    GetAclInformation,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_WRITE};

const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 0x3;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const INHERITED_ACE: u8 = 0x10;

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 目录是否已有 capability SID 的 allow-write ACE(直接或继承)。
unsafe fn has_capability_ace(dacl: *mut ACL, sid: *const c_void) -> bool {
    let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
    if GetAclInformation(
        dacl as *const ACL,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
        AclSizeInformation,
    ) == 0
    {
        return false;
    }
    #[repr(C)]
    struct AceHeader {
        AceType: u8,
        AceFlags: u8,
        AceSize: u16,
    }
    #[repr(C)]
    struct AccessAllowedAce {
        Header: AceHeader,
        Mask: u32,
        SidStart: u32,
    }
    for i in 0..info.AceCount {
        let mut ace: *mut c_void = std::ptr::null_mut();
        if GetAce(dacl, i, &mut ace) == 0 {
            continue;
        }
        let header = ace as *const AceHeader;
        if (*header).AceType != ACCESS_ALLOWED_ACE_TYPE {
            continue;
        }
        let allowed = ace as *const AccessAllowedAce;
        let mask = (*allowed).Mask;
        // FILE_GENERIC_WRITE 含 WRITE_DAC 等泛型位映射后的具体位;只要求"可写数据"位集合
        if (mask & (FILE_GENERIC_WRITE & 0x0000_02FF)) == 0 {
            continue;
        }
        let sid_ptr = (allowed as *const u8).add(std::mem::size_of::<AccessAllowedAce>() - 4) as *const c_void;
        if windows_sys::Win32::Security::EqualSid(sid_ptr as *mut _, sid as *mut _) != 0 {
            return true;
        }
    }
    false
}

/// 给目录挂 capability SID 的 allow-write 继承 ACE(幂等;不动既有条目)。
pub unsafe fn grant_write_access(path: &str, capability_sid_bytes: &[u8]) -> Result<(), String> {
    // 1) 读现有 DACL
    let wide = to_wide(path);
    let mut existing: *mut ACL = std::ptr::null_mut();
    let mut sec_desc: *mut c_void = std::ptr::null_mut();
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    let rc = GetNamedSecurityInfoW(
        wide.as_ptr(),
        1,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut existing,
        std::ptr::null_mut(),
        &mut sec_desc,
    );
    if rc != ERROR_SUCCESS {
        return Err(format!("读取目录安全信息失败({}): {}", path, rc));
    }

    // 2) 幂等检查
    if !existing.is_null() && has_capability_ace(existing, capability_sid_bytes.as_ptr() as *const c_void) {
        LocalFree(sec_desc as HLOCAL);
        return Ok(());
    }

    // 3) EXPLICIT_ACCESS_W{GRANT_ACCESS, FILE_GENERIC_WRITE, 继承} → 合成新 DACL
    let entries = [EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_GENERIC_WRITE,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: Default::default(),
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: Default::default(),
            ptstrName: capability_sid_bytes.as_ptr() as *mut u16,
        },
    }];

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let rc2 = SetEntriesInAclW(
        1,
        entries.as_ptr(),
        existing,
        &mut new_dacl,
    );
    LocalFree(sec_desc as HLOCAL);
    if rc2 != ERROR_SUCCESS {
        return Err(format!("合成授权失败({}): {}", path, rc2));
    }

    // 4) 写回(不置 PROTECTED:保留继承链)
    let rc3 = SetNamedSecurityInfoW(
        wide.as_ptr(),
        1,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        new_dacl,
        std::ptr::null_mut(),
    );
    LocalFree(new_dacl as HLOCAL);
    if rc3 != ERROR_SUCCESS {
        return Err(format!("写入目录授权失败({}): {}", path, rc3));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::sid_from_sddl;

    #[test]
    #[ignore = "需要真实文件系统(开发机 smoke:npm run sandbox:test)"]
    fn grant_is_idempotent() {
        unsafe {
            let sid = sid_from_sddl("S-1-5-80-1234567890-1234567890-1234567890-1234567890-1234567890").unwrap();
            let dir = std::env::temp_dir().join("dwg-acl-smoke");
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.to_string_lossy().to_string();
            grant_write_access(&path, &sid).unwrap();
            grant_write_access(&path, &sid).unwrap(); // 幂等不炸
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
