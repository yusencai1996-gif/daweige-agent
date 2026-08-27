import { describe, expect, it } from 'vitest'
import { decideExecPolicy, selfCheckRules } from '../../../src/main/command/exec-policy'

describe('ExecPolicy 规则自检', () => {
  it('全部规则 match/notMatch 自检通过(引擎可用)', () => {
    expect(selfCheckRules()).toBeNull()
  })
})

describe('ExecPolicy allow 白名单(用户 2026-08-27 批准 4 条)', () => {
  it.each(['Get-Location', 'get-location', 'pwd', 'WHOAMI', 'whoami', 'hostname'])(
    '%s 免卡',
    (cmd) => {
      expect(decideExecPolicy(cmd).decision).toBe('allow')
    },
  )
  it.each([
    'Get-Location -Foo',
    'whoami /priv',
    'hostname extra',
    'pwd; Get-ChildItem',
    'whoami && hostname',
  ])('%s 带参数/组合 → 退回 prompt', (cmd) => {
    expect(decideExecPolicy(cmd).decision).toBe('prompt')
  })
})

describe('ExecPolicy forbidden 六类', () => {
  it('格式化/磁盘/引导', () => {
    for (const cmd of ['format d:', 'format.com d:', 'diskpart', 'bootrec /fixmbr', 'bcdedit /set x', 'Clear-Disk -Number 1', 'Remove-Partition -DiskNumber 1']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
  })
  it('注册表修改', () => {
    for (const cmd of ['reg add HKLM\\x', 'REG DELETE HKLM\\x', 'reg import a.reg', 'regedit /s a.reg', 'Set-ItemProperty -Path HKLM:\\x -Name y', 'Remove-Item -Path Registry::HKEY_LOCAL_MACHINE\\x']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
    // 只读注册表 → prompt(可弹卡人审),不误杀
    expect(decideExecPolicy('reg query HKLM\\x').decision).toBe('prompt')
    expect(decideExecPolicy('Get-Item HKLM:\\x').decision).toBe('prompt')
  })
  it('提权/绕过/动态执行', () => {
    for (const cmd of ['runas /user:admin cmd', 'sudo rm x', 'gsudo x', 'psexec -s cmd', 'powershell -EncodedCommand AAAA', 'pwsh -encodedcommand AAA', 'iex $x', 'Invoke-Expression $evil', 'Start-Process setup -Verb RunAs']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
    expect(decideExecPolicy('Start-Process notepad').decision).toBe('prompt')
  })
  it('系统目录破坏(含变量/引号/环境变量展开)', () => {
    for (const cmd of [
      'Remove-Item C:\\Windows\\System32\\x',
      'del %windir%\\x',
      'rm -r $env:SystemRoot/x',
      'rmdir "C:\\Program Files\\x"',
      'Remove-Item C:\\ProgramData\\x -Recurse',
      'del c:\\windows\\x',
    ]) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
    // 用户目录内删除不在此规则(有沙箱与文件工具双防线)→ prompt
    expect(decideExecPolicy('del C:\\Users\\demo\\file.txt').decision).toBe('prompt')
    expect(decideExecPolicy('Remove-Item .\\x').decision).toBe('prompt')
  })
  it('权限/账户/服务/计划任务', () => {
    for (const cmd of ['takeown /f x', 'net user evil pass /add', 'net localgroup administrators evil /add', 'sc create evil', 'sc delete wuauserv', 'schtasks /create /tn x /tr y', 'icacls C:\\x /grant admin:f']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
    expect(decideExecPolicy('sc query wuauserv').decision).toBe('prompt')
    expect(decideExecPolicy('schtasks /query').decision).toBe('prompt')
    expect(decideExecPolicy('icacls C:\\x').decision).toBe('prompt')
  })
  it('关机与防护关闭', () => {
    for (const cmd of ['shutdown /s', 'shutdown /r /t 0', 'Restart-Computer', 'Stop-Computer', 'Set-MpPreference -DisableRealtimeMonitoring $true', 'netsh advfirewall set allprofiles state off']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('forbidden')
    }
    expect(decideExecPolicy('netsh advfirewall show allprofiles').decision).toBe('prompt')
    expect(decideExecPolicy('Get-MpPreference').decision).toBe('prompt')
  })
})

describe('ExecPolicy 输入卫生与组合语义', () => {
  it('空/超长/控制字符直接拒', () => {
    expect(decideExecPolicy('   ').decision).toBe('forbidden')
    expect(decideExecPolicy('a'.repeat(16_385)).decision).toBe('forbidden')
      expect(decideExecPolicy('Get-Location\x00; evil').decision).toBe('forbidden')
  })
  it('组合命令最严格优先:allow 段+forbidden 段=forbidden', () => {
    expect(decideExecPolicy('Get-Location; format d:').decision).toBe('forbidden')
    expect(decideExecPolicy('whoami | diskpart').decision).toBe('forbidden')
  })
  it('重定向/子表达式/反引号 → prompt', () => {
    for (const cmd of ['Get-ChildItem > out.txt', 'Write-Output $(calc)', 'echo `dir`']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('prompt')
    }
  })
  it('正常工作命令 → prompt(人审)', () => {
    for (const cmd of ['Get-ChildItem', 'python summarize.py', 'Copy-Item a.txt b.txt', 'node -e "console.log(1)"']) {
      expect(decideExecPolicy(cmd).decision, cmd).toBe('prompt')
    }
  })
  it('大小写与 NFKC 归一(全角字母绕过)', () => {
    expect(decideExecPolicy('FORMAT D:').decision).toBe('forbidden')
    expect(decideExecPolicy('ｆｏｒｍａｔ d:').decision).toBe('forbidden')
  })
  it('引号内内容不逃逸 token 匹配,但特征正则仍扫原文', () => {
    // 引号包裹的命令名仍是第一 token(del "C:\Program Files\x")
    expect(decideExecPolicy('del "C:\\Program Files\\x"').decision).toBe('forbidden')
  })
})
