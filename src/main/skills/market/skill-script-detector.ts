export const SCRIPT_SKILL_REJECTION =
  '这个技能依赖脚本或可执行文件。大微阁 0.7.0 只安装纯文字技能，所以这次没有安装；以后开放受信脚本技能时会明确说明风险并仍走沙箱。'

export interface ScriptDetection {
  readonly unsafe: boolean
  readonly reason?: string
}

export function detectSkillScripts(markdown: string): ScriptDetection {
  const checks: readonly [RegExp, string][] = [
    [/(?:\([^)]*|\b)scripts?[\\/]/i, '引用 scripts 目录'],
    [/\b[^\s)`"']+\.(?:py|sh|ps1|bat|cmd|exe|js|mjs|cjs)\b/i, '引用脚本或可执行文件'],
    [/\b(?:python3?|node|bash|powershell|pwsh)\s+(?:\.\.?[\\/]|[^\s]+[\\/])?[^\s]+\.(?:py|js|mjs|cjs|sh|ps1)\b/i, '要求运行相对脚本'],
    [/\b(?:npm|pnpm|yarn|pip3?|uv|apt(?:-get)?|brew|choco|winget)\s+(?:install|add)\b/i, '要求安装软件包'],
    [/\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/i, '要求下载并执行脚本'],
  ]
  for (const [pattern, reason] of checks) {
    if (pattern.test(markdown)) return { unsafe: true, reason }
  }
  return { unsafe: false }
}
