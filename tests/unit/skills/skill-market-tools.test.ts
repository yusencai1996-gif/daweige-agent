import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { GitHubRegistry } from '../../../src/main/skills/market/github-registry'
import { createSearchSkillsTool } from '../../../src/main/skills/market/skill-market-tools'
import { SkillInstallTokenStore } from '../../../src/main/skills/market/skill-install-token-store'
import { SkillRegistryHttpClient } from '../../../src/main/skills/market/skill-registry-http-client'
import { SkillRegistryService } from '../../../src/main/skills/market/registry-service'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

describe('search_skills tool', () => {
  it.each([
    'meeting sk-12345678901234567890',
    'meeting api_key=verysecretvalue123',
  ])('搜索词命中密钥形态时在 fetch 前整体拒绝:%s', async (query) => {
    const requestedUrls: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({ items: [] }))
    })
    const registry = new SkillRegistryService([
      new GitHubRegistry(new SkillRegistryHttpClient({ fetchImpl })),
    ])
    const tool = createSearchSkillsTool({
      sessionId: 's1', registry,
      broker: new ApprovalBroker(() => {}),
      tokens: new SkillInstallTokenStore(),
      installations: {} as never, catalog: {} as never,
    })

    await expect(tool.execute('call-secret', { query }, undefined, undefined))
      .rejects.toThrow('搜索词里可能有密钥或敏感信息,已停止联网搜索;请换个说法描述要装的技能。')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(requestedUrls).toEqual([])
  })

  it('installToken 绑定会话、十分钟过期且只能消费一次', () => {
    let n = 0
    const tokens = new SkillInstallTokenStore(() => `inst_token_${++n}_12345678`)
    const candidate = { optionId: 'option-123', registryId: 'curated' as const, slug: 'safe', displayName: 'Safe', summary: '' }
    const cross = tokens.issue('s1', candidate, 'real-safe', 1_000)
    expect(() => tokens.consume(cross, 's2', 2_000)).toThrow(/不属于/)
    const expired = tokens.issue('s1', candidate, 'real-safe', 1_000)
    expect(() => tokens.consume(expired, 's1', 1_000 + 10 * 60_000)).toThrow(/失效/)
  })

  it('候选 optionId 由 broker 绑定，选择后只返回一次性 token', async () => {
    const events: AgentPushEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const tokens = new SkillInstallTokenStore(() => 'inst_test_token_123456')
    const registry = new SkillRegistryService([{
      id: 'curated', displayName: '精选目录',
      search: async () => [
        { registryId: 'curated', slug: 'one', displayName: 'One', summary: 'one', license: 'MIT' },
        { registryId: 'curated', slug: 'two', displayName: 'Two', summary: 'two', license: 'MIT' },
      ],
      fetchSkill: async () => { throw new Error('not used') },
    }])
    const tool = createSearchSkillsTool({
      sessionId: 's1', registry,
      broker, tokens,
      installations: {} as never, catalog: {} as never,
    })
    const pending = tool.execute('call-1', { query: 'meeting', limit: 2 }, undefined, undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const event = events.find((item) => item.type === 'approval_required')
    if (!event || event.type !== 'approval_required' || event.request.kind !== 'skill-candidate') throw new Error('没有候选卡')
    const secondOption = event.request.candidates[1]?.optionId
    if (!secondOption) throw new Error('没有第二个候选')
    broker.resolve({ approvalId: event.request.id, decision: 'approve', selectedOptionId: secondOption })
    const result = await pending
    expect(JSON.stringify(result)).toContain('inst_test_token_123456')
    const claim = tokens.consume('inst_test_token_123456', 's1')
    expect(claim.fetchSlug).toBe('two')
    expect(() => tokens.consume('inst_test_token_123456', 's1')).toThrow(/失效/)
  })
})
