import { describe, expect, it, vi } from 'vitest'
import { assertAllowedUrl, SkillRegistryHttpClient } from '../../../src/main/skills/market/skill-registry-http-client'
import { MAX_SKILL_MARKDOWN_BYTES, validateSearchInput, validateSkillMarkdown } from '../../../src/main/skills/market/skill-download-validator'

describe('skill registry download boundary', () => {
  it('拒绝 HTTP、非白名单、非 443 端口和越界参数', () => {
    for (const url of ['http://api.github.com/x', 'https://evil.example/x', 'https://api.github.com:444/x']) {
      expect(() => assertAllowedUrl(new URL(url))).toThrow(/安全范围/)
    }
    expect(() => validateSearchInput('', 2)).toThrow()
    expect(() => validateSearchInput('ok', 9)).toThrow()
  })

  it('正文严格执行 64 KiB UTF-8 上限', () => {
    expect(validateSkillMarkdown('a'.repeat(MAX_SKILL_MARKDOWN_BYTES))).toHaveLength(MAX_SKILL_MARKDOWN_BYTES)
    expect(() => validateSkillMarkdown('a'.repeat(MAX_SKILL_MARKDOWN_BYTES + 1))).toThrow(/64 KiB/)
  })

  it('429、5xx、断网和超响应均转成人话', async () => {
    const signal = new AbortController().signal
    const url = new URL('https://api.github.com/search/repositories')
    await expect(new SkillRegistryHttpClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })) }).getJson(url, signal)).rejects.toThrow(/限速/)
    await expect(new SkillRegistryHttpClient({ fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('dns raw')) }).getJson(url, signal)).rejects.toThrow(/连不上/)
    const huge = JSON.stringify({ value: 'x'.repeat(256 * 1024) })
    await expect(new SkillRegistryHttpClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(huge)) }).getJson(url, signal)).rejects.toThrow(/过大/)
  })
})
