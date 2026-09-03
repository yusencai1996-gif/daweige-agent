import { describe, expect, it } from 'vitest'
import type { SkillRegistry } from '../../../src/main/skills/market/registry'
import { SkillRegistryService } from '../../../src/main/skills/market/registry-service'

const signal = new AbortController().signal

function registry(id: 'curated' | 'github', slugs: readonly string[]): SkillRegistry {
  return {
    id, displayName: id,
    search: async () => slugs.map((slug) => ({ registryId: id, slug, displayName: slug, summary: slug, license: 'MIT' })),
    fetchSkill: async ({ slug }) => ({ registryId: id, slug, displayName: slug, summary: slug, license: 'MIT', markdown: '# ok' }),
  }
}

describe('SkillRegistryService', () => {
  it('精选优先、达到 limit 后不再联网，并生成 opaque optionId', async () => {
    let githubCalls = 0
    const github = registry('github', ['later'])
    const wrapped = { ...github, search: async (input: Parameters<SkillRegistry['search']>[0]) => { githubCalls += 1; return github.search(input) } }
    const service = new SkillRegistryService([registry('curated', ['a', 'b']), wrapped])
    const result = await service.search({ query: 'budget', limit: 2, signal })
    expect(result.candidates.map((item) => item.slug)).toEqual(['a', 'b'])
    expect(result.candidates.every((item) => item.optionId.length >= 8)).toBe(true)
    expect(githubCalls).toBe(0)
  })

  it('GitHub 断网降级为提示，不抹掉精选候选', async () => {
    const github: SkillRegistry = { ...registry('github', []), search: async () => { throw new Error('raw secret') } }
    const result = await new SkillRegistryService([registry('curated', ['a']), github])
      .search({ query: 'budget', limit: 3, signal })
    expect(result.candidates).toHaveLength(1)
    expect(result.notices).toContain('GitHub 暂时无法搜索。')
  })
})
