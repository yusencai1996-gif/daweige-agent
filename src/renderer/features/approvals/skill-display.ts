import type { SkillMarketCandidate, SkillRegistryId } from '../../../shared/domain'

/**
 * 技能展示共享纯函数(0.7.0 A/B):候选卡、安装预览卡、WRITE 技能分支、SkillPanel 共用。
 * 只消费契约字段,不发明数据;字段缺失一律省略,不猜。
 */

/** registryId → 中文来源标签(契约枚举只有 curated/github,映射写死在前端是安全的)。 */
export function registryLabel(registryId: SkillRegistryId): string {
  switch (registryId) {
    case 'curated':
      return '内置精选'
    case 'github':
      return 'GitHub'
  }
}

/** 千分位计数(不依赖 ICU 本地化,任何运行环境输出一致):1280 → "1,280"。 */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 受控技能逻辑 URI → 人话位置;绝不把 URI 原文摆上卡片。
 * 只识别契约约定的两种形态;不认识的形态返回 null(调用方降级为笼统说法)。
 */
export function humanizeSkillLocation(logicalLocation: string): string | null {
  const globalMatch = /^daweige-skill:\/\/global\/([^/]+)\/SKILL\.md$/.exec(logicalLocation)
  if (globalMatch) return `全局技能 / ${globalMatch[1]}`
  const roleMatch = /^daweige-skill:\/\/role\/[^/]+\/([^/]+)\/SKILL\.md$/.exec(logicalLocation)
  if (roleMatch) return `角色技能 / ${roleMatch[1]}`
  return null
}

/**
 * WRITE 技能分支的技能名:从 FileApprovalRequest.samplePaths 里找受控逻辑 URI 解析。
 * 找不到返回 null(调用方只显示「全局技能」,不编造名字)。
 */
export function skillNameFromSamplePaths(samplePaths: readonly string[]): string | null {
  for (const path of samplePaths) {
    const match = /^daweige-skill:\/\/global\/([^/]+)\/SKILL\.md$/.exec(path)
    if (match) return match[1] ?? null
  }
  return null
}

/** 候选/来源的统计与元信息行:作者、下载/安装/星标、版本、许可;全缺时返回空串(不渲染该行)。 */
export function candidateMetaLine(candidate: SkillMarketCandidate): string {
  const parts: string[] = []
  if (candidate.owner !== undefined && candidate.owner !== '') parts.push(`作者 ${candidate.owner}`)
  if (candidate.installs !== undefined) parts.push(`${formatCount(candidate.installs)} 次安装`)
  if (candidate.downloads !== undefined) parts.push(`${formatCount(candidate.downloads)} 次下载`)
  if (candidate.stars !== undefined) parts.push(`${formatCount(candidate.stars)} 星标`)
  if (candidate.version !== undefined && candidate.version !== '') parts.push(`版本 ${candidate.version}`)
  if (candidate.license !== undefined && candidate.license !== '') parts.push(`许可 ${candidate.license}`)
  return parts.join(' · ')
}
