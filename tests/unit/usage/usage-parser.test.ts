import { describe, expect, it } from 'vitest'
import {
  currentIanaTimeZone,
  localDateFor,
  parseAssistantUsage,
  parseCompactionUsage,
} from '../../../src/main/usage/usage-parser'
import type { AgentMessage, CompactionEntry } from '@earendil-works/pi-agent-core'

/** 构造带 usage 的 assistant 消息(覆盖 pi AssistantMessage 关键字段)。 */
function assistantMessage(overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: 'anthropic-messages',
    provider: 'kimi-coding',
    model: 'kimi-for-coding',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.UTC(2026, 7, 24, 2, 0, 0), // 2026-08-24 02:00 UTC
    ...overrides,
  } as unknown as AgentMessage
}

describe('usage-parser:parseAssistantUsage', () => {
  const input = {
    sourceEntryId: 'entry-1',
    sessionId: 's1',
    timeZone: 'Asia/Shanghai',
  }

  it('assistant 消息解析出全部字段', () => {
    const event = parseAssistantUsage({ ...input, message: assistantMessage() })
    expect(event).toBeDefined()
    expect(event?.sourceEntryId).toBe('entry-1')
    expect(event?.provider).toBe('kimi-coding')
    expect(event?.modelId).toBe('kimi-for-coding')
    expect(event?.inputTokens).toBe(100)
    expect(event?.outputTokens).toBe(50)
    expect(event?.totalTokens).toBe(165)
    expect(event?.localDate).toBe('2026-08-24') // UTC 02:00 = 上海 10:00 同日
    expect(event?.timezoneId).toBe('Asia/Shanghai')
    expect(event?.stopReason).toBe('stop')
  })

  it('费用字段不进入事件(cost 不落库口径)', () => {
    const event = parseAssistantUsage({ ...input, message: assistantMessage() })
    expect(event && 'cost' in event).toBe(false)
  })

  it('user 消息不解析', () => {
    const message = { role: 'user', content: 'q', timestamp: Date.now() } as unknown as AgentMessage
    expect(parseAssistantUsage({ ...input, message })).toBeUndefined()
  })

  it('responseModel 优先记录', () => {
    const event = parseAssistantUsage({
      ...input,
      message: assistantMessage({ responseModel: 'kimi-for-coding-v2' }),
    })
    expect(event?.modelId).toBe('kimi-for-coding')
    expect(event?.responseModelId).toBe('kimi-for-coding-v2')
  })

  it('totalTokens 与四项之和不一致时按四项重算', () => {
    const message = assistantMessage({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 999, // 上报值不可信
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    expect(parseAssistantUsage({ ...input, message })?.totalTokens).toBe(165)
  })

  it('负数 / 非有限值 / 非安全整数拒绝', () => {
    for (const bad of [
      { input: -1 },
      { output: Number.NaN },
      { cacheRead: Number.POSITIVE_INFINITY },
      { cacheWrite: 1.5 },
    ]) {
      const message = assistantMessage({
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          ...bad,
        },
      })
      expect(parseAssistantUsage({ ...input, message })).toBeUndefined()
    }
  })

  it('缺 provider/model 拒绝', () => {
    expect(
      parseAssistantUsage({ ...input, message: assistantMessage({ provider: '' }) }),
    ).toBeUndefined()
    expect(
      parseAssistantUsage({ ...input, message: assistantMessage({ model: '' }) }),
    ).toBeUndefined()
  })

  it('usage 全零也记录(数据完整性,不伪造)', () => {
    const message = assistantMessage({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    const event = parseAssistantUsage({ ...input, message })
    expect(event?.totalTokens).toBe(0)
  })
})

describe('usage-parser:时区归日', () => {
  it('同一时刻在不同时区归到不同自然日', () => {
    const ms = Date.UTC(2026, 7, 23, 18, 30) // 2026-08-23 18:30 UTC
    expect(localDateFor(ms, 'Asia/Shanghai')).toBe('2026-08-24') // 上海 02:30 次日
    expect(localDateFor(ms, 'UTC')).toBe('2026-08-23')
    expect(localDateFor(ms, 'America/New_York')).toBe('2026-08-23')
  })

  it('currentIanaTimeZone 返回合法标识', () => {
    const tz = currentIanaTimeZone()
    expect(typeof tz).toBe('string')
    expect(tz.length).toBeGreaterThan(0)
  })
})

describe('usage-parser:compaction usage', () => {
  it('从 details.daweige 恢复模型快照并固定 stop_reason=compaction', () => {
    const entry: CompactionEntry = {
      type: 'compaction', id: 'c1', seq: 1, parentId: null,
      timestamp: Date.UTC(2026, 7, 24, 2), summary: '摘要', retainedTail: [], tokensBefore: 1000,
      usage: {
        input: 80, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 105,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      details: { daweige: { providerId: 'zai', modelId: 'glm-5.3' } },
    }
    expect(parseCompactionUsage({
      sourceEntryId: 's1:c1', sessionId: 's1', entry, timeZone: 'Asia/Shanghai',
    })).toMatchObject({
      sourceEntryId: 's1:c1', provider: 'zai', modelId: 'glm-5.3',
      totalTokens: 105, stopReason: 'compaction',
    })
  })

  it('缺模型快照或 usage 时拒绝，不伪造统计', () => {
    const base: CompactionEntry = {
      type: 'compaction', id: 'c1', seq: 1, parentId: null, timestamp: 1,
      summary: '摘要', retainedTail: [], tokensBefore: 1000,
    }
    expect(parseCompactionUsage({ sourceEntryId: 'x', sessionId: 's', entry: base, timeZone: 'UTC' })).toBeUndefined()
  })
})
