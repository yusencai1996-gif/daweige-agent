import { describe, expect, it, vi } from 'vitest'
import { CuratedCatalogRegistry } from '../../../src/main/skills/market/curated-catalog'
import { SkillRegistryHttpClient } from '../../../src/main/skills/market/skill-registry-http-client'

describe('CuratedCatalogRegistry', () => {
  it('中文名称/简介/标签本地命中，builtin 获取不联网', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const registry = new CuratedCatalogRegistry(new SkillRegistryHttpClient({ fetchImpl }))
    const found = await registry.search({ query: '记账 表格', limit: 5, signal: new AbortController().signal })
    expect(found[0]?.slug).toBe('household-budget-sheet')
    const detail = await registry.fetchSkill({ slug: 'household-budget-sheet', signal: new AbortController().signal })
    expect(detail.markdown).toContain('name: household-budget-sheet')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('remote 只构造 raw.githubusercontent.com 坐标', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('---\nname: summarize-meeting\ndescription: ok\n---\nbody'))
    const registry = new CuratedCatalogRegistry(new SkillRegistryHttpClient({ fetchImpl }))
    await registry.fetchSkill({ slug: 'summarize-meeting', signal: new AbortController().signal })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://raw.githubusercontent.com/phuryn/pm-skills/main/')
  })
})
