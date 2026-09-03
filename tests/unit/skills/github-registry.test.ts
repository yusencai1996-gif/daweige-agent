import { describe, expect, it, vi } from 'vitest'
import { GitHubRegistry } from '../../../src/main/skills/market/github-registry'
import { SkillRegistryHttpClient } from '../../../src/main/skills/market/skill-registry-http-client'

describe('GitHubRegistry', () => {
  it('只保留许可证白名单并按 stars 排序，同 query 60 秒缓存', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [
      { full_name: 'ok/high', description: 'x', stargazers_count: 9, default_branch: 'main', license: { spdx_id: 'MIT' } },
      { full_name: 'bad/none', description: 'x', stargazers_count: 99, license: null },
      { full_name: 'ok/low', description: 'x', stargazers_count: 1, license: { spdx_id: 'BSD-3-Clause' } },
    ] }), { headers: { 'content-type': 'application/json' } }))
    const registry = new GitHubRegistry(new SkillRegistryHttpClient({ fetchImpl }))
    const input = { query: 'meeting', limit: 3, signal: new AbortController().signal }
    expect((await registry.search(input)).map((item) => item.slug)).toEqual(['ok/high', 'ok/low'])
    await registry.search(input)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(registry.lastFilteredByLicense).toBe(1)
  })

  it('fetch 仅从一层 contents 枚举常见路径后拉 raw', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: 'ok/repo', default_branch: 'main', description: 'd', license: { spdx_id: 'MIT' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: 'skills', path: 'skills', type: 'dir' }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: 'SKILL.md', path: 'skills/SKILL.md', type: 'file' }])))
      .mockResolvedValueOnce(new Response('---\nname: repo\ndescription: ok\n---\nbody'))
    const registry = new GitHubRegistry(new SkillRegistryHttpClient({ fetchImpl }))
    const detail = await registry.fetchSkill({ slug: 'ok/repo', signal: new AbortController().signal })
    expect(detail.markdown).toContain('name: repo')
    expect(String(fetchImpl.mock.calls[3]?.[0])).toContain('raw.githubusercontent.com/ok/repo/main/skills/SKILL.md')
  })
})
