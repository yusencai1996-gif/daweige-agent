import { describe, expect, it, vi } from 'vitest'
import {
  CompactionError,
  prepareCompaction,
  type AgentMessage,
  type CompactionEntry,
  type Entry,
  type Session,
} from '@earendil-works/pi-agent-core'
import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import {
  CompactionService,
  shouldRequestCompaction,
} from '../../../src/main/agent/compaction-service'
import {
  COMPACTION_EXECUTION_SETTINGS,
  triggerReserveTokens,
} from '../../../src/main/agent/compaction-policy'

const usageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function assistantWithUsage(totalTokens: number): AgentMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'faux',
    provider: 'faux',
    model: 'faux-1',
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: usageCost,
    },
    stopReason: 'stop',
    timestamp: 1,
  }
}

function messageEntry(id: string, message: AgentMessage, seq: number): Entry {
  return { type: 'message', id, seq, parentId: seq > 1 ? `e${seq - 1}` : null, timestamp: seq, message }
}

function model(contextWindow = 100_000): Model<Api> {
  return {
    id: 'faux-1',
    name: 'Faux',
    api: 'faux',
    provider: 'faux',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
  }
}

describe('A-29 compaction 触发策略', () => {
  it.each([
    [79_900, false],
    [80_000, false],
    [80_100, true],
  ])('%s/100000 的阈值结果为 %s', (tokens, expected) => {
    expect(shouldRequestCompaction([assistantWithUsage(tokens)], 100_000)).toBe(expected)
  })

  it.each([
    ['Kimi', 262_144],
    ['GLM', 1_000_000],
    ['DeepSeek', 1_000_000],
    ['表外模型', 131_072],
  ])('%s context window 使用 20%% trigger reserve', (_name, window) => {
    expect(triggerReserveTokens(window)).toBe(Math.floor(window * 0.2))
    // pi 的 shouldCompact 是严格大于:触发点 = window - reserve;floor(0.8w)+1 在 w 不整除时会恰好落在触发点上,故用与 reserve 对齐的边界
    const triggerPoint = window - Math.floor(window * 0.2)
    expect(shouldRequestCompaction([assistantWithUsage(triggerPoint)], window)).toBe(false)
    expect(shouldRequestCompaction([assistantWithUsage(triggerPoint + 1)], window)).toBe(true)
  })

  it('小 context window 时 reserve 被 cap 到 80%,触发点不为负(防每轮压缩)', () => {
    // pi 默认 reserve 16384 > 窗口 10000,不 cap 会变成 tokens > -6384 恒真
    expect(triggerReserveTokens(10_000)).toBe(8_000)
    // 触发点 = 10000 - 8000 = 2000
    expect(shouldRequestCompaction([assistantWithUsage(1_999)], 10_000)).toBe(false)
    expect(shouldRequestCompaction([assistantWithUsage(2_001)], 10_000)).toBe(true)
  })

  it('没有 provider usage 时按字符保守估算', () => {
    const user: AgentMessage = { role: 'user', content: '甲'.repeat(321), timestamp: 1 }
    expect(shouldRequestCompaction([user], 100)).toBe(true)
  })

  it('二次压缩把 previous compaction summary 带入 preparation', () => {
    const previous: CompactionEntry = {
      type: 'compaction', id: 'c1', seq: 1, parentId: null, timestamp: 1,
      summary: '第一轮摘要事实', retainedTail: [], tokensBefore: 50_000,
    }
    const entries: Entry[] = [
      previous,
      messageEntry('e2', { role: 'user', content: '新事实'.repeat(20_000), timestamp: 2 }, 2),
      messageEntry('e3', assistantWithUsage(50_000), 3),
      messageEntry('e4', { role: 'user', content: '尾部'.repeat(20_000), timestamp: 4 }, 4),
    ]
    const prepared = prepareCompaction(entries, COMPACTION_EXECUTION_SETTINGS)
    expect(prepared.ok).toBe(true)
    if (prepared.ok) expect(prepared.value?.previousSummary).toBe('第一轮摘要事实')
  })
})

describe('A-29 CompactionService 提交顺序', () => {
  const preparation = {
    messagesToSummarize: [], turnPrefixMessages: [], retainedTail: [], isSplitTurn: false,
    tokensBefore: 90_000, fileOps: {
      read: new Set<string>(), written: new Set<string>(), edited: new Set<string>(),
    },
    settings: COMPACTION_EXECUTION_SETTINGS,
  }
  const compactUsage: Usage = {
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: usageCost,
  }

  function target(appendEntry: ReturnType<typeof vi.fn>) {
    const replaceMessages = vi.fn()
    const session = {
      findEntriesOnBranch: vi.fn(async () => []),
      appendEntry,
      idGenerator: { next: () => 'c1' },
    } as unknown as Session<SqliteSessionMetadata>
    return {
      replaceMessages,
      value: { sessionId: 's1', session, model: model(), messages: [], replaceMessages },
    }
  }

  it('compact 失败不写 entry、不替换 state', async () => {
    const appendEntry = vi.fn()
    const t = target(appendEntry)
    const service = new CompactionService({
      models: { completeSimple: vi.fn() as never }, emitEvent: vi.fn(),
      prepare: vi.fn(() => ({ ok: true as const, value: preparation })),
      runCompact: vi.fn(async () => ({ ok: false as const, error: new CompactionError('summarization_failed', 'boom') })),
    })
    await expect(service.execute(t.value, new AbortController().signal)).rejects.toThrow('boom')
    expect(appendEntry).not.toHaveBeenCalled()
    expect(t.replaceMessages).not.toHaveBeenCalled()
  })

  it('entry 写失败不替换 state、不推成功事件', async () => {
    const emitEvent = vi.fn()
    const appendEntry = vi.fn(async () => { throw new Error('sqlite write failed') })
    const t = target(appendEntry)
    const service = new CompactionService({
      models: { completeSimple: vi.fn() as never }, emitEvent,
      prepare: vi.fn(() => ({ ok: true as const, value: preparation })),
      runCompact: vi.fn(async () => ({ ok: true as const, value: {
        summary: '摘要', tokensBefore: 90_000, retainedTail: [], usage: compactUsage,
      } })),
    })
    await expect(service.execute(t.value, new AbortController().signal)).rejects.toThrow('sqlite write failed')
    expect(t.replaceMessages).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('abort 会取消正在生成的摘要且不落半成品', async () => {
    const appendEntry = vi.fn()
    const t = target(appendEntry)
    const controller = new AbortController()
    const service = new CompactionService({
      models: { completeSimple: vi.fn() as never }, emitEvent: vi.fn(),
      prepare: vi.fn(() => ({ ok: true as const, value: preparation })),
      runCompact: vi.fn(async (_p, _m, _model, _instructions, signal: AbortSignal | undefined) => {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { ok: false as const, error: new CompactionError('aborted', 'aborted') }
      }),
    })
    const pending = service.execute(t.value, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('压缩已取消')
    expect(appendEntry).not.toHaveBeenCalled()
  })
})
