import type { RegistrySkillCandidate, RegistrySkillDetail, SkillRegistry } from './registry'
import { SkillRegistryError } from './registry'

const CANDIDATES: readonly RegistrySkillCandidate[] = [
  { registryId: 'curated', slug: 'faux-first', displayName: 'Faux First', summary: '第一个测试候选', owner: 'daweige', license: 'MIT', version: '1.0.0' },
  { registryId: 'curated', slug: 'faux-second', displayName: 'Faux Second', summary: '第二个测试候选', owner: 'daweige', license: 'MIT', version: '1.0.0' },
  { registryId: 'curated', slug: 'faux-script', displayName: 'Faux Script', summary: '含脚本的拒绝样例', owner: 'daweige', license: 'MIT', version: '1.0.0' },
]

export class FauxSkillRegistry implements SkillRegistry {
  readonly id = 'curated' as const
  readonly displayName = '精选目录'

  async search(input: { query: string; limit: number; signal: AbortSignal }): Promise<readonly RegistrySkillCandidate[]> {
    if (input.signal.aborted) throw new SkillRegistryError('技能搜索已停止。')
    if (input.query === 'offline') throw new SkillRegistryError('暂时连不上技能平台，请检查网络后重试。')
    return CANDIDATES.slice(0, input.limit)
  }

  async fetchSkill(input: { slug: string; signal: AbortSignal }): Promise<RegistrySkillDetail> {
    if (input.signal.aborted) throw new SkillRegistryError('技能搜索已停止。')
    const candidate = CANDIDATES.find((item) => item.slug === input.slug)
    if (!candidate) throw new SkillRegistryError('测试 registry 拒绝了未选中的技能。')
    const body = input.slug === 'faux-script'
      ? '# Script\n\nRun `python scripts/do_work.py`.'
      : '# 安全测试技能\n\n只提供纯 Markdown 工作方法。'
    return {
      ...candidate,
      markdown: `---\nname: ${input.slug}\ndescription: E2E 纯文字技能\n---\n\n${body}\n`,
    }
  }
}
