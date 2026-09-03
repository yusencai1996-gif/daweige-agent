// 0.7.0 E-4/E-7:记忆分页状态合并规则的针对性单测。
// 环境无 DOM(vitest environment=node),分页/reset/mergeState 逻辑抽在
// memory-paging.ts 纯函数里,这里用 MockBridge 驱动验证;
// 「加载更多」按钮点击与弹层键盘焦点由 Playwright E2E(memory-paging.spec.ts)覆盖。
import { describe, expect, it } from 'vitest'
import {
  applyMemoryClear,
  applyMemoryDelete,
  applyMemoryPage,
  fetchFirstMemoryPage,
  fetchNextMemoryPage,
  MEMORY_PAGE_SIZE,
} from '../../../src/renderer/features/settings/memory-paging'
import type { MemoryListPage, MemoryNoteSummary } from '../../../src/shared/domain'
import { MockBridge } from '../../helpers/mock-bridge'

function makeEntry(index: number): MemoryNoteSummary {
  return {
    id: `2026-08-30T12-00-00-note-${String(index).padStart(3, '0')}.md`,
    content: `第 ${index} 条记忆`,
    createdAt: 1_760_000_000_000 + index,
    source: { kind: 'conversation', roleId: 'sys-xiaozhen', roleDisplayName: '小柊' },
  }
}

function makePage(overrides: Partial<MemoryListPage> & { entries: readonly MemoryNoteSummary[] }): MemoryListPage {
  return {
    revision: 1,
    mergeState: 'clean',
    total: overrides.entries.length,
    reset: false,
    ...overrides,
  }
}

/**
 * 用 MockBridge 覆写一套 N 条记忆的分页 fixture,
 * 语义对齐真实后端:游标绑定 revision,revision 失配时 reset=true 回第一页;
 * delete/clear 成功 bump revision 并把 mergeState 置 pending。
 */
function seedPagedMemory(bridge: MockBridge, count: number): void {
  let revision = 1
  let entries = Array.from({ length: count }, (_, i) => makeEntry(i + 1))
  bridge.handle('memory:list', ({ cursor, limit = 50 }) => {
    const match = cursor === undefined ? null : /^mock:(\d+):(\d+)$/.exec(cursor)
    const reset = cursor !== undefined && (match === null || Number(match[1]) !== revision)
    const offset = reset || match === null ? 0 : Number(match[2])
    const page = entries.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    return {
      revision,
      mergeState: 'clean' as const,
      entries: page,
      ...(nextOffset < entries.length ? { nextCursor: `mock:${revision}:${nextOffset}` } : {}),
      total: entries.length,
      reset,
    }
  })
  bridge.handle('memory:delete', ({ memoryId }) => {
    const before = entries.length
    entries = entries.filter((entry) => entry.id !== memoryId)
    const deleted = entries.length !== before
    if (deleted) revision += 1
    return { deleted, revision, mergeState: deleted ? ('pending' as const) : ('clean' as const) }
  })
  bridge.handle('memory:clear', () => {
    const deletedCount = entries.length
    entries = []
    if (deletedCount > 0) revision += 1
    return { deletedCount, revision, mergeState: deletedCount > 0 ? ('pending' as const) : ('clean' as const) }
  })
}

describe('applyMemoryPage(0.7.0 E-4)', () => {
  it('reset=false:新页追加在已加载条目之后,页元数据以新页为准', () => {
    const prev = makePage({ entries: [makeEntry(1), makeEntry(2)], nextCursor: 'mock:1:2', total: 4 })
    const next = makePage({ entries: [makeEntry(3), makeEntry(4)], total: 4 })
    const merged = applyMemoryPage(prev, next)
    expect(merged.entries.map((e) => e.id)).toEqual([
      prev.entries[0]!.id,
      prev.entries[1]!.id,
      next.entries[0]!.id,
      next.entries[1]!.id,
    ])
    expect(merged.nextCursor).toBeUndefined()
    expect(merged.total).toBe(4)
  })

  it('reset=true(revision 变了):整页替换,绝不拼接新旧快照', () => {
    const prev = makePage({ entries: [makeEntry(1), makeEntry(2)], nextCursor: 'mock:1:2', total: 4 })
    const freshFirst = makePage({ entries: [makeEntry(9)], total: 1, revision: 2, reset: true })
    const merged = applyMemoryPage(prev, freshFirst)
    expect(merged.entries).toHaveLength(1)
    expect(merged.entries[0]!.id).toBe(makeEntry(9).id)
    expect(merged.revision).toBe(2)
  })

  it('prev 为 null:直接用新页', () => {
    const page = makePage({ entries: [makeEntry(1)] })
    expect(applyMemoryPage(null, page)).toBe(page)
  })
})

describe('MockBridge 驱动的翻页流程(0.7.0 E-4)', () => {
  it('120 条:首屏 50 → 追加到 100 → 追加到 120,nextCursor 耗尽', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 120)

    const first = await fetchFirstMemoryPage(bridge)
    expect(first.entries).toHaveLength(MEMORY_PAGE_SIZE)
    expect(first.total).toBe(120)
    expect(first.reset).toBe(false)
    expect(first.nextCursor).toBeDefined()

    const second = await fetchNextMemoryPage(bridge, first)
    expect(second.entries).toHaveLength(100)
    expect(second.reset).toBe(false)
    // 追加不重复:首尾 id 顺序正确
    expect(second.entries[0]!.id).toBe(first.entries[0]!.id)
    expect(second.entries[99]!.content).toBe('第 100 条记忆')

    const third = await fetchNextMemoryPage(bridge, second)
    expect(third.entries).toHaveLength(120)
    expect(third.nextCursor).toBeUndefined()
  })

  it('翻页中途删除一条:旧游标失效,响应 reset=true,已加载列表被新第一页替换', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 120)

    const first = await fetchFirstMemoryPage(bridge)
    expect(first.entries).toHaveLength(50)

    // 中途删除第一页里的一条:revision bump,旧 nextCursor 失效
    const deletedId = first.entries[0]!.id
    const deleteResult = await bridge.invoke('memory:delete', { memoryId: deletedId })
    expect(deleteResult.deleted).toBe(true)

    const afterReset = await fetchNextMemoryPage(bridge, first)
    expect(afterReset.reset).toBe(true)
    // 不拼接:替换后就是新第一页,而不是 50+50
    expect(afterReset.entries).toHaveLength(50)
    expect(afterReset.total).toBe(119)
    expect(afterReset.entries.some((e) => e.id === deletedId)).toBe(false)
  })

  it('没有 nextCursor 时 fetchNextMemoryPage 原样返回,不再发请求', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 10)
    const first = await fetchFirstMemoryPage(bridge)
    expect(first.nextCursor).toBeUndefined()
    bridge.resetCalls()
    const same = await fetchNextMemoryPage(bridge, first)
    expect(same).toBe(first)
    expect(bridge.calls).toHaveLength(0)
  })
})

describe('mergeState 即时更新(0.7.0 E-7 附带)', () => {
  it('删除成功:条目立即消失、total-1、revision/mergeState 用响应值(pending)', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 3)
    const first = await fetchFirstMemoryPage(bridge)
    const target = first.entries[1]!

    const result = await bridge.invoke('memory:delete', { memoryId: target.id })
    expect(result.mergeState).toBe('pending')
    const next = applyMemoryDelete(first, target.id, result)
    expect(next.entries.map((e) => e.id)).toEqual([first.entries[0]!.id, first.entries[2]!.id])
    expect(next.total).toBe(2)
    expect(next.mergeState).toBe('pending')
    expect(next.revision).toBe(result.revision)
  })

  it('清空成功:列表归零、nextCursor 清掉、mergeState 用响应值(pending)', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 120)
    const first = await fetchFirstMemoryPage(bridge)
    expect(first.nextCursor).toBeDefined()

    const result = await bridge.invoke('memory:clear', undefined)
    expect(result.deletedCount).toBe(120)
    expect(result.mergeState).toBe('pending')
    const next = applyMemoryClear(first, result)
    expect(next.entries).toHaveLength(0)
    expect(next.total).toBe(0)
    expect(next.nextCursor).toBeUndefined()
    expect(next.mergeState).toBe('pending')
    expect(next.revision).toBe(result.revision)
  })

  it('删除未命中(deleted=false):mergeState 保持 clean,调用方不应 apply', async () => {
    const bridge = new MockBridge()
    seedPagedMemory(bridge, 2)
    const result = await bridge.invoke('memory:delete', { memoryId: 'no-such-id' })
    expect(result.deleted).toBe(false)
    expect(result.mergeState).toBe('clean')
  })
})
