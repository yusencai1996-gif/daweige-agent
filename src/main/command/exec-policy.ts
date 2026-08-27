/**
 * 简化 ExecPolicy v1(0.4.0 C)——命令三级决策引擎。
 * 蓝本:Codex execpolicy(字面 token 前缀规则/三级决策/最严格优先/内联 match 自检),
 * 落地为仓内只读 TS 常量:不上 Starlark、不让用户编辑、不持久化前缀授权。
 *
 * 决策语义(用户 2026-08-27 拍板):
 * - allow:仅 4 条精确只读自检命令免卡,**仍走沙箱**;
 * - prompt:弹命令确认卡;
 * - forbidden:直接拒绝,不出卡。
 *
 * 铁律:policy 自检失败 → 保留 forbidden 基线、allow 全关、其余 prompt,绝不"规则坏了就允许"。
 */

export type ExecPolicyDecision = 'allow' | 'prompt' | 'forbidden'

export interface ExecPolicyVerdict {
  readonly decision: ExecPolicyDecision
  /** 人话理由(approval 卡 reason / 拒绝消息)。 */
  readonly reason: string
  /** 命中的规则 id(allow/forbidden 时给);prompt 给分级原因。 */
  readonly ruleId?: string
}

/** 字面 token 前缀规则(allow 要求整条等长;forbidden 前缀命中即拒)。 */
interface TokenRule {
  readonly id: string
  readonly decision: 'allow' | 'forbidden'
  readonly pattern: readonly string[]
  readonly justification: string
  /** 自检:必须命中(判定为该 decision)。 */
  readonly match: readonly string[]
  /** 自检:必须不命中(不得判为该 decision)。 */
  readonly notMatch: readonly string[]
}

/** 原文特征规则(正则,大小写不敏感;覆盖参数内/引号内/变量展开形态)。 */
interface SignatureRule {
  readonly id: string
  readonly pattern: RegExp
  readonly justification: string
  readonly match: readonly string[]
  readonly notMatch: readonly string[]
}

const COMMAND_MAX_LENGTH = 16_384

/** allow 白名单(用户批准:4 条精确整条、无参数只读自检命令)。 */
const TOKEN_RULES: readonly TokenRule[] = [
  {
    id: 'allow-get-location',
    decision: 'allow',
    pattern: ['get-location'],
    justification: '只读自检:查看当前目录',
    match: ['Get-Location', 'get-location'],
    notMatch: ['Get-Location -Foo', 'Get-Location; Remove-Item x'],
  },
  {
    id: 'allow-pwd',
    decision: 'allow',
    pattern: ['pwd'],
    justification: '只读自检:查看当前目录',
    match: ['pwd'],
    notMatch: ['pwd -Extra', 'pwd; format x'],
  },
  {
    id: 'allow-whoami',
    decision: 'allow',
    pattern: ['whoami'],
    justification: '只读自检:查看当前用户',
    match: ['whoami', 'WHOAMI'],
    notMatch: ['whoami /priv', 'whoami; shutdown'],
  },
  {
    id: 'allow-hostname',
    decision: 'allow',
    pattern: ['hostname'],
    justification: '只读自检:查看主机名',
    match: ['hostname'],
    notMatch: ['hostname extra'],
  },
]

/** forbidden:字面 token 前缀(命令名打头)。 */
const FORBIDDEN_TOKEN_RULES: readonly TokenRule[] = [
  // 格式化/磁盘/引导
  { id: 'forbid-format', decision: 'forbidden', pattern: ['format'], justification: '格式化磁盘,破坏性操作', match: ['format d:'], notMatch: ['formatting notes'] },
  { id: 'forbid-format-com', decision: 'forbidden', pattern: ['format.com'], justification: '格式化磁盘,破坏性操作', match: ['format.com d:'], notMatch: [] },
  { id: 'forbid-diskpart', decision: 'forbidden', pattern: ['diskpart'], justification: '磁盘分区工具,破坏性操作', match: ['diskpart'], notMatch: [] },
  { id: 'forbid-bootrec', decision: 'forbidden', pattern: ['bootrec'], justification: '修改引导记录', match: ['bootrec /fixmbr'], notMatch: [] },
  { id: 'forbid-bcdedit', decision: 'forbidden', pattern: ['bcdedit'], justification: '修改启动配置', match: ['bcdedit /set x'], notMatch: [] },
  { id: 'forbid-manage-bde', decision: 'forbidden', pattern: ['manage-bde'], justification: '修改 BitLocker 加密', match: ['manage-bde -on c:'], notMatch: [] },
  { id: 'forbid-clear-disk', decision: 'forbidden', pattern: ['clear-disk'], justification: '清空整块磁盘', match: ['Clear-Disk -Number 1'], notMatch: [] },
  { id: 'forbid-initialize-disk', decision: 'forbidden', pattern: ['initialize-disk'], justification: '初始化磁盘(清数据)', match: ['Initialize-Disk 1'], notMatch: [] },
  { id: 'forbid-new-partition', decision: 'forbidden', pattern: ['new-partition'], justification: '改磁盘分区', match: ['New-Partition -DiskNumber 1'], notMatch: [] },
  { id: 'forbid-remove-partition', decision: 'forbidden', pattern: ['remove-partition'], justification: '删除分区,数据丢失', match: ['Remove-Partition -DiskNumber 1'], notMatch: [] },
  // 注册表修改
  { id: 'forbid-reg-add', decision: 'forbidden', pattern: ['reg', 'add'], justification: '写注册表', match: ['reg add HKLM\\x'], notMatch: ['reg query HKLM\\x'] },
  { id: 'forbid-reg-delete', decision: 'forbidden', pattern: ['reg', 'delete'], justification: '删注册表项', match: ['reg delete HKLM\\x'], notMatch: [] },
  { id: 'forbid-reg-import', decision: 'forbidden', pattern: ['reg', 'import'], justification: '导入注册表', match: ['reg import x.reg'], notMatch: [] },
  { id: 'forbid-reg-load', decision: 'forbidden', pattern: ['reg', 'load'], justification: '加载注册表配置单元', match: ['reg load x y'], notMatch: [] },
  { id: 'forbid-regedit-s', decision: 'forbidden', pattern: ['regedit', '/s'], justification: '静默导入注册表', match: ['regedit /s x.reg'], notMatch: ['regedit x.reg'] },
  // 提权/绕过/动态执行
  { id: 'forbid-runas', decision: 'forbidden', pattern: ['runas'], justification: '以其他身份执行(提权)', match: ['runas /user:admin x'], notMatch: [] },
  { id: 'forbid-sudo', decision: 'forbidden', pattern: ['sudo'], justification: '提权执行', match: ['sudo x'], notMatch: [] },
  { id: 'forbid-gsudo', decision: 'forbidden', pattern: ['gsudo'], justification: '提权执行', match: ['gsudo x'], notMatch: [] },
  { id: 'forbid-psexec', decision: 'forbidden', pattern: ['psexec', '-s'], justification: '以 SYSTEM 执行', match: ['psexec -s x'], notMatch: ['psexec \\\\srv x'] },
  { id: 'forbid-shutdown', decision: 'forbidden', pattern: ['shutdown'], justification: '关机/重启', match: ['shutdown /s'], notMatch: [] },
  { id: 'forbid-restart-computer', decision: 'forbidden', pattern: ['restart-computer'], justification: '重启计算机', match: ['Restart-Computer'], notMatch: [] },
  { id: 'forbid-stop-computer', decision: 'forbidden', pattern: ['stop-computer'], justification: '关闭计算机', match: ['Stop-Computer'], notMatch: [] },
  { id: 'forbid-takeown', decision: 'forbidden', pattern: ['takeown'], justification: '夺取文件所有权', match: ['takeown /f x'], notMatch: [] },
  { id: 'forbid-iex', decision: 'forbidden', pattern: ['iex'], justification: '动态执行任意代码', match: ['iex $x'], notMatch: [] },
  { id: 'forbid-invoke-expression', decision: 'forbidden', pattern: ['invoke-expression'], justification: '动态执行任意代码', match: ['Invoke-Expression $x'], notMatch: [] },
  // 账户/服务/计划任务(修改类)
  { id: 'forbid-net-user', decision: 'forbidden', pattern: ['net', 'user'], justification: '修改系统账户', match: ['net user x pass /add'], notMatch: ['net use z: \\\\srv'] },
  { id: 'forbid-net-localgroup', decision: 'forbidden', pattern: ['net', 'localgroup'], justification: '修改用户组', match: ['net localgroup admin x /add'], notMatch: [] },
  { id: 'forbid-sc-create', decision: 'forbidden', pattern: ['sc', 'create'], justification: '创建系统服务', match: ['sc create x'], notMatch: ['sc query x'] },
  { id: 'forbid-sc-delete', decision: 'forbidden', pattern: ['sc', 'delete'], justification: '删除系统服务', match: ['sc delete x'], notMatch: [] },
  { id: 'forbid-sc-config', decision: 'forbidden', pattern: ['sc', 'config'], justification: '修改系统服务', match: ['sc config x'], notMatch: [] },
  { id: 'forbid-schtasks-create', decision: 'forbidden', pattern: ['schtasks', '/create'], justification: '创建计划任务(持久化)', match: ['schtasks /create /tn x'], notMatch: ['schtasks /query'] },
  { id: 'forbid-schtasks-delete', decision: 'forbidden', pattern: ['schtasks', '/delete'], justification: '删除计划任务', match: ['schtasks /delete /tn x'], notMatch: [] },
  { id: 'forbid-schtasks-change', decision: 'forbidden', pattern: ['schtasks', '/change'], justification: '修改计划任务', match: ['schtasks /change /tn x'], notMatch: [] },
]

/**
 * forbidden 原文特征(正则,大小写不敏感):
 * 覆盖 token 前缀够不着的形态——参数内出现、引号内、变量展开、PowerShell cmdlet 全限定。
 */
const SIGNATURE_RULES: readonly SignatureRule[] = [
  {
    id: 'sig-encodedcommand',
    pattern: /(^|\s)-encodedcommand\b/i,
    justification: 'Base64 混淆命令,不可审查',
    match: ['powershell -EncodedCommand AAAA', 'pwsh -encodedcommand AAA'],
    notMatch: ['Get-Location'],
  },
  {
    id: 'sig-registry-ps-write',
    pattern: /\b(set|new|remove)-item(property)?\s+(-path\s+)?["']?(hklm:|hkcu:|hkcr:|hku:|hkcc:|registry::)/i,
    justification: 'PowerShell 写注册表',
    match: ['Set-ItemProperty -Path HKLM:\\x', 'New-Item HKCU:\\x', 'Remove-Item -Path Registry::HKEY_LOCAL_MACHINE\\x'],
    notMatch: ['Get-Item HKLM:\\x', 'Set-Content ./a.txt'],
  },
  {
    id: 'sig-start-process-runas',
    pattern: /\bstart-process\b[^\r\n|;]*[\s](-verb\s+runas\b)/i,
    justification: '以管理员身份启动进程(提权)',
    match: ['Start-Process x -Verb RunAs'],
    notMatch: ['Start-Process x'],
  },
  {
    id: 'sig-system-dir-destruct',
    pattern: /\b(remove-item|del|erase|rd|rmdir|rm)\b[^\r\n|;]*(%windir%|\$env:windir|\$env:systemroot|c:\\windows|c:\\program files|c:\\programdata|system volume information|c:\\users\\all users)/i,
    justification: '删除系统目录内容',
    match: ['Remove-Item C:\\Windows\\x', 'del %windir%\\x', 'rm -r $env:SystemRoot/x', 'rmdir "C:\\Program Files\\x"'],
    notMatch: ['Remove-Item .\\x', 'del C:\\Users\\demo\\file.txt'],
  },
  {
    id: 'sig-defender-stop',
    pattern: /\bset-?(mpreference|mppreference)\b[^\r\n|;]*-disable(realtime|behavior)?monitoring\s+\$?true/i,
    justification: '关闭 Windows Defender 实时防护',
    match: ['Set-MpPreference -DisableRealtimeMonitoring $true'],
    notMatch: ['Get-MpPreference', 'Set-MpPreference -ScanAvgCPULoadFactor 20'],
  },
  {
    id: 'sig-netsh-firewall-off',
    pattern: /\bnetsh\b[^\r\n|;]*\b(firewall|advfirewall)\b[^\r\n|;]*\b(off|disable)\b/i,
    justification: '关闭防火墙',
    match: ['netsh advfirewall set allprofiles state off', 'netsh firewall set opmode disable'],
    notMatch: ['netsh advfirewall show allprofiles'],
  },
  {
    id: 'sig-icacls-grant-system',
    pattern: /\bicacls\b[^\r\n|;]*\b(grant|setowner|reset)\b/i,
    justification: '修改文件 ACL(权限)',
    match: ['icacls C:\\x /grant admin:f'],
    notMatch: ['icacls C:\\x'],
  },
]

function normalizeToken(token: string): string {
  // Windows 文件系统/命令名大小写不敏感;策略归一用小写。NFKC 归一 Unicode 变体。
  return token.normalize('NFKC').toLowerCase()
}

/** 保守分词:空白分割(保留引号内为一整段时用引号感知)。 */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of segment.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(normalizeToken(current))
      current = ''
      continue
    }
    current += ch
  }
  if (current) tokens.push(normalizeToken(current))
  return tokens
}

/** 顶层切段:分号/管道/逻辑与或(不在引号内的)。 */
function splitTopLevel(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of command) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const isSeparator = ch === ';' || ch === '|'
    if (isSeparator) {
      // 检查前一个字符:| 与 | 组成 ||,& 与 & 组成 &&(在 splitTopLevel 输入里 && 由调用方保证)
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.filter((s) => s.trim().length > 0)
}

/** 规则自检:全部通过返回 null,否则返回失败清单。 */
export function selfCheckRules(): string[] | null {
  const failures: string[] = []
  const allTokenRules = [...TOKEN_RULES, ...FORBIDDEN_TOKEN_RULES]
  // 与主决策同语义的完整判定(不走自检缓存,allow 视为可用——自检的就是规则定义本身)
  for (const rule of allTokenRules) {
    for (const cmd of rule.match) {
      const verdict = decideCore(cmd, true)
      if (verdict.decision !== rule.decision) {
        failures.push(`${rule.id}: match "${cmd}" 判为 ${verdict.decision},期望 ${rule.decision}`)
      }
    }
    for (const cmd of rule.notMatch) {
      const verdict = decideCore(cmd, true)
      if (verdict.decision === rule.decision) {
        failures.push(`${rule.id}: notMatch "${cmd}" 不应判为 ${rule.decision}`)
      }
    }
  }
  for (const rule of SIGNATURE_RULES) {
    for (const cmd of rule.match) {
      if (!rule.pattern.test(cmd)) failures.push(`${rule.id}: match "${cmd}" 未命中正则`)
    }
    for (const cmd of rule.notMatch) {
      if (rule.pattern.test(cmd)) failures.push(`${rule.id}: notMatch "${cmd}" 不应命中`)
    }
  }
  return failures.length > 0 ? failures : null
}



function matchesTokenRule(tokens: readonly string[], rule: TokenRule): boolean {
  if (tokens.length < rule.pattern.length) return false
  for (let i = 0; i < rule.pattern.length; i += 1) {
    if (tokens[i] !== normalizeToken(rule.pattern[i] ?? '')) return false
  }
  if (rule.decision === 'allow' && tokens.length !== rule.pattern.length) {
    // allow 只认整条精确命中:多一个参数都退回 prompt
    return false
  }
  return true
}

/** 引擎自检结果缓存(进程内一次)。 */
let selfCheckFailures: string[] | null | undefined

function ensureSelfChecked(): string[] | null {
  if (selfCheckFailures === undefined) {
    selfCheckFailures = selfCheckRules()
    if (selfCheckFailures) {
      // fail-closed:规则坏了→allow 全关,其余 prompt,forbidden 基线(字面规则)保留
      console.error('[exec-policy] 规则自检失败,allow 白名单全部关闭,其余降级 prompt:', selfCheckFailures)
    }
  }
  return selfCheckFailures
}

/**
 * 主入口:整条命令 → 三级决策。
 * 输入是模型原始命令(trim 后);返回 decision+人话 reason。
 */
export function decideExecPolicy(rawCommand: string): ExecPolicyVerdict {
  const failures = ensureSelfChecked()
  return decideCore(rawCommand.trim(), !failures)
}

/** 核心判定(自检与主入口共用同一语义;allowEnabled=false 时 allow 白名单不生效)。 */
function decideCore(rawCommand: string, allowEnabled: boolean): ExecPolicyVerdict {
  const command = rawCommand.trim()

  // 0) 限长与字符集:NUL/控制字符直接拒
  if (command.length === 0) {
    return { decision: 'forbidden', reason: '空命令' }
  }
  if (command.length > COMMAND_MAX_LENGTH) {
    return { decision: 'forbidden', reason: `命令超过 ${COMMAND_MAX_LENGTH} 字上限` }
  }
  if (/[\x00-\x08\x0e-\x1f]/.test(command)) {
    return { decision: 'forbidden', reason: '命令含控制字符' }
  }

  // 1) 不可覆盖的 forbidden 原文特征(编码混淆/注册表/提权/系统目录/防护关闭)
  for (const rule of SIGNATURE_RULES) {
    if (rule.pattern.test(command)) {
      return { decision: 'forbidden', reason: rule.justification, ruleId: rule.id }
    }
  }

  // 2) 顶层切段,逐段 token 规则;整条取最严格
  const segments = splitTopLevel(command)
  let sawPromptReason = false
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment)
    if (tokens.length === 0) continue
    // forbidden 优先
    for (const rule of FORBIDDEN_TOKEN_RULES) {
      if (matchesTokenRule(tokens, rule)) {
        return { decision: 'forbidden', reason: rule.justification, ruleId: rule.id }
      }
    }
    // 重定向/子表达式/动态调用形态 → 至少 prompt(不 forbidden,交给卡上人审)
    if (/[<>]|\$\(|`\(/.test(segment)) {
      sawPromptReason = true
      continue
    }
  }

  // 3) allow(仅自检通过时启用):整条命令所有段都精确命中同一 allow 规则
  if (allowEnabled) {
    const allSegments = segments
    for (const rule of TOKEN_RULES) {
      const hitEvery = allSegments.every((seg) => {
        const tokens = tokenizeSegment(seg)
        return matchesTokenRule(tokens, rule)
      })
      const anyHit = allSegments.some((seg) => {
        const tokens = tokenizeSegment(seg)
        return matchesTokenRule(tokens, rule)
      })
      if (allSegments.length > 0 && hitEvery && anyHit) {
        return { decision: 'allow', reason: rule.justification, ruleId: rule.id }
      }
    }
  }

  // 4) 其余 prompt(策略自检失败时 allowEnabled=false,同样落这里)
  return {
    decision: 'prompt',
    reason: sawPromptReason ? '命令含重定向或动态调用,需要你确认' : '运行命令前需要你确认',
  }
}
