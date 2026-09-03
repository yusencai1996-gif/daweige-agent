import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlobalMemoryStore } from '../../../src/main/memory/global-memory-store'

let dir: string
const source = { kind: 'conversation' as const, roleId: null, roleDisplayName: '小柊' }
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-search-e1-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('E-1 中文 n-gram 搜索', () => {
  it('完整问句、短词、中英混合、NFKC 标点可命中，重复 gram 去重且单个噪声 gram 不入选', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    await store.addNote({ filename: '2026-09-03T16-05-00-tea.md', note: '用户长期喜欢喝绿茶，项目代号是 Agent Ａ。' }, source)
    await store.addNote({ filename: '2026-09-03T16-05-01-noise.md', note: '这里只偶然出现“喜欢”两个字。' }, source)
    expect((await store.search('请问用户喜欢喝什么茶？'))[0]?.excerpt).toContain('绿茶')
    expect((await store.search('绿茶')).some((hit) => hit.excerpt.includes('绿茶'))).toBe(true)
    expect((await store.search('Agent A，绿茶')).some((hit) => hit.excerpt.includes('项目代号'))).toBe(true)
    expect(await store.search('请问我想知道喜欢喝什么饮料呢')).toHaveLength(1)
    const capped = await store.search('喜欢喜欢喜欢喝绿茶', 1)
    expect(capped).toHaveLength(1)
    expect(Buffer.byteLength(capped[0]!.excerpt, 'utf8')).toBeLessThanOrEqual(20 * 1024)
  })
})
