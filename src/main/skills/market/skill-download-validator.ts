import { SkillRegistryError } from './registry'

export const MAX_SKILL_MARKDOWN_BYTES = 64 * 1024
export const MAX_REGISTRY_JSON_BYTES = 256 * 1024

export function validateSearchInput(query: string, limit: number): { query: string; limit: number } {
  const normalized = query.trim()
  if ([...normalized].length < 1 || [...normalized].length > 120) {
    throw new SkillRegistryError('搜索词要在 1 到 120 个字符之间。')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
    throw new SkillRegistryError('技能候选数量要在 1 到 8 之间。')
  }
  return { query: normalized, limit }
}

export function validateSkillMarkdown(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SKILL_MARKDOWN_BYTES) {
    throw new SkillRegistryError('这个技能的 SKILL.md 超过 64 KiB，暂时不能安装。')
  }
  if (value.includes('\uFFFD')) {
    throw new SkillRegistryError('这个技能的 SKILL.md 不是有效的 UTF-8 文本，暂时不能安装。')
  }
  return value
}
