import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_SESSION_GAP_MS,
  computeLongestActiveSessionDuration,
  UsageStore,
} from '../../../src/main/usage/usage-store'
import { localDateFor, type ParsedUsageEvent } from '../../../src/main/usage/usage-parser'

/**
 * 使用统计存储单测:幂等插入 / 四类聚合 / 连续天数 / 365 骨架补零 / 会话跨度。
 */

const TZ = 'Asia/Shanghai'

let root: string
let store: UsageStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daweige-usage-'))
  store = new UsageStore(join(root, 'usage.sqlite'))
})

afterEach(async () => {
  await store.drainAndClose()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

let seq = 0
function event(overrides: Partial<ParsedUsageEvent> = {}): ParsedUsageEvent {
  seq += 1
  const occurredAtMs = Date.UTC(2026, 7, 24, 2, 0, 0)
  return {
    sourceEntryId: `entry-${seq}`,
    sessionId: 's1',
    provider: 'kimi-coding',
    modelId: 'kimi-for-coding',
    responseModelId: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: null,
    totalTokens: 165,
    occurredAtMs,
    localDate: localDateFor(occurredAtMs, TZ),
    timezoneId: TZ,
    stopReason: 'stop',
    ...overrides,
  }
}

describe('usage-store:插入与幂等', () => {
  it('重复 source_entry_id 二次插入被忽略,计数只增一次', async () => {
    const e = event()
    expect(await store.insertEvents([e], 'live')).toBe(1)
    expect(await store.insertEvents([e], 'backfill')).toBe(0)
  })

  it('live 后 backfill 不重复(跨 source_kind 幂等)', async () => {
    const e = event()
    await store.insertEvents([e], 'live')
    expect(await store.insertEvents([e, event()], 'backfill')).toBe(1)
  })

  it('空数组直接 0,不开事务', async () => {
    expect(await store.insertEvents([], 'live')).toBe(0)
  })

  it('按 session 参数化归集轮次与各类 token，缺失会话补零', async () => {
    await store.insertEvents([
      event({ sessionId: 'child-1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 35 }),
      event({ sessionId: 'child-1', inputTokens: 5, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 12 }),
      event({ sessionId: 'other', totalTokens: 999 }),
    ], 'live')
    const totals = await store.getSessionTotals(['child-1', 'missing'])
    expect(totals.get('child-1')).toEqual({
      rounds: 2,
      inputTokens: 15,
      outputTokens: 26,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 47,
    })
    expect(totals.get('missing')).toEqual({
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    })
    expect(await store.getSessionTotals([])).toEqual(new Map())
  })
})

describe('usage-store:dashboard 聚合', () => {
  it('无数据:hasData=false,五卡零值,骨架完整', async () => {
    const d = await store.buildDashboard(Date.UTC(2026, 7, 24, 12), TZ)
    expect(d.hasData).toBe(false)
    expect(d.overview.totalTokens).toBe(0)
    expect(d.overview.currentStreakDays).toBe(0)
    expect(d.activity.days).toHaveLength(365)
    expect(d.trend.dates).toHaveLength(30)
    expect(d.models.items).toHaveLength(0)
  })

  it('总量 = 四项之和的合计;峰值 = 单日最大;模型降序且 responseModel 优先', async () => {
    const day1 = { localDate: '2026-08-22', occurredAtMs: Date.UTC(2026, 7, 22, 2) }
    const day2 = { localDate: '2026-08-23', occurredAtMs: Date.UTC(2026, 7, 23, 2) }
    await store.insertEvents(
      [
        event({ ...day1, totalTokens: 100 }),
        event({ ...day1, totalTokens: 150 }),
        event({ ...day2, provider: 'zai', modelId: 'glm-5.3', responseModelId: 'glm-5.3-live', totalTokens: 900 }),
        event({ ...day2, provider: 'zai', modelId: 'glm-5.3', responseModelId: 'glm-5.3-live', totalTokens: 100 }),
      ],
      'live',
    )
    const d = await store.buildDashboard(Date.UTC(2026, 7, 23, 12), TZ)
    expect(d.hasData).toBe(true)
    expect(d.overview.totalTokens).toBe(1250)
    expect(d.overview.peakDailyTokens).toBe(1000)
    // 模型键取 responseModel;两家不合并
    expect(d.models.items).toHaveLength(2)
    expect(d.models.items[0]?.model).toBe('glm-5.3-live')
    expect(d.models.items[0]?.totalTokens).toBe(1000)
    expect(d.models.items[1]?.model).toBe('kimi-for-coding')
  })

  it('连续天数:断档与今天无用量', async () => {
    // 三天连续(8/20、8/21、8/22)+ 更早孤日(8/10);"今天"=8/23 无用量
    await store.insertEvents(
      [
        event({ localDate: '2026-08-10', occurredAtMs: Date.UTC(2026, 7, 10, 2) }),
        event({ localDate: '2026-08-20', occurredAtMs: Date.UTC(2026, 7, 20, 2) }),
        event({ localDate: '2026-08-21', occurredAtMs: Date.UTC(2026, 7, 21, 2) }),
        event({ localDate: '2026-08-22', occurredAtMs: Date.UTC(2026, 7, 22, 2) }),
      ],
      'backfill',
    )
    const d = await store.buildDashboard(Date.UTC(2026, 7, 23, 12), TZ)
    expect(d.overview.currentStreakDays).toBe(0) // 今天(8/23)无用量
    expect(d.overview.longestStreakDays).toBe(3)
  })

  it('连续天数:以今天结尾时 current 与 longest 相等', async () => {
    await store.insertEvents(
      [
        event({ localDate: '2026-08-22', occurredAtMs: Date.UTC(2026, 7, 22, 2) }),
        event({ localDate: '2026-08-23', occurredAtMs: Date.UTC(2026, 7, 23, 2) }),
      ],
      'live',
    )
    const d = await store.buildDashboard(Date.UTC(2026, 7, 23, 12), TZ)
    expect(d.overview.currentStreakDays).toBe(2)
    expect(d.overview.longestStreakDays).toBe(2)
  })

  it('活动骨架 365 天含今天,缺失日补零;趋势 30 天对齐', async () => {
    await store.insertEvents([event({ localDate: '2026-08-23', occurredAtMs: Date.UTC(2026, 7, 23, 2) })], 'live')
    const d = await store.buildDashboard(Date.UTC(2026, 7, 23, 12), TZ)
    expect(d.activity.days).toHaveLength(365)
    expect(d.activity.toDate).toBe('2026-08-23')
    expect(d.activity.days[364]).toEqual({ date: '2026-08-23', totalTokens: 165 })
    expect(d.activity.days[363]?.totalTokens).toBe(0)
    expect(d.activity.fromDate).toBe('2025-08-24')
    // 趋势序列与模型对齐
    expect(d.trend.dates).toHaveLength(30)
    expect(d.trend.series).toHaveLength(1)
    expect(d.trend.series[0]?.values).toHaveLength(30)
    expect(d.trend.series[0]?.values[29]).toBe(165)
    // 三图同源:日桶和 = 模型总量 = 总览
    const sum = d.activity.days.reduce((a, b) => a + b.totalTokens, 0)
    expect(sum).toBe(d.models.totalTokens)
    expect(sum).toBe(d.overview.totalTokens)
  })

  it('同名模型不同 provider 不合并', async () => {
    await store.insertEvents(
      [
        event({ provider: 'kimi-coding', modelId: 'shared-model' }),
        event({ provider: 'deepseek', modelId: 'shared-model' }),
      ],
      'live',
    )
    const d = await store.buildDashboard(Date.UTC(2026, 7, 24, 12), TZ)
    expect(d.models.items).toHaveLength(2)
  })
})

describe('usage-store:活跃时长', () => {
  const row = (sessionId: string, occurredAtMs: number) => ({ sessionId, occurredAtMs })

  it('t0、+10m、+130m 只累计 10 分钟', () => {
    expect(computeLongestActiveSessionDuration([
      row('s1', 0), row('s1', 10 * 60_000), row('s1', 130 * 60_000),
    ])).toBe(10 * 60_000)
  })

  it('恰好 30 分钟计入', () => {
    expect(computeLongestActiveSessionDuration([row('s1', 0), row('s1', ACTIVE_SESSION_GAP_MS)]))
      .toBe(ACTIVE_SESSION_GAP_MS)
  })

  it('30 分钟加 1 毫秒断开', () => {
    expect(computeLongestActiveSessionDuration([row('s1', 0), row('s1', ACTIVE_SESSION_GAP_MS + 1)]))
      .toBe(0)
  })

  it('两个 session 取连续累计较长的 45 分钟', () => {
    expect(computeLongestActiveSessionDuration([
      row('s1', 0), row('s1', 10 * 60_000),
      row('s2', 0), row('s2', 20 * 60_000), row('s2', 45 * 60_000),
    ])).toBe(45 * 60_000)
  })

  it('单事件为 0', () => {
    expect(computeLongestActiveSessionDuration([row('s1', 123)])).toBe(0)
  })

  it('乱序与重复时间戳稳定', () => {
    expect(computeLongestActiveSessionDuration([
      row('s1', 20 * 60_000), row('s1', 0), row('s1', 10 * 60_000), row('s1', 10 * 60_000),
    ])).toBe(20 * 60_000)
  })

  it('dashboard 从稳定排序的 usage events 单遍累计', async () => {
    await store.insertEvents([
      event({ sourceEntryId: 'late', sessionId: 's1', occurredAtMs: 20 * 60_000 }),
      event({ sourceEntryId: 'early', sessionId: 's1', occurredAtMs: 0 }),
      event({ sourceEntryId: 'middle', sessionId: 's1', occurredAtMs: 10 * 60_000 }),
    ], 'live')
    const d = await store.buildDashboard(Date.UTC(2026, 7, 24, 12), TZ)
    expect(d.schemaVersion).toBe(2)
    expect(d.overview.longestActiveSessionDurationMs).toBe(20 * 60_000)
  })

  it('老库只有 spans、没有 events 时返回 0', async () => {
    await store.upsertSessionSpan('legacy', 0)
    await store.upsertSessionSpan('legacy', 120 * 60_000)
    const d = await store.buildDashboard(Date.UTC(2026, 7, 24, 12), TZ)
    expect(d.overview.longestActiveSessionDurationMs).toBe(0)
  })
})

describe('usage-store:串行队列', () => {
  it('并发批量写全部落库(不丢批)', async () => {
    const batches = Array.from({ length: 20 }, (_, b) =>
      Array.from({ length: 25 }, (_, i) => event({ sourceEntryId: `e-${b}-${i}` })),
    )
    const counts = await Promise.all(batches.map((b) => store.insertEvents(b, 'live')))
    expect(counts.reduce((a, b) => a + b, 0)).toBe(500)
    const d = await store.buildDashboard(Date.UTC(2026, 7, 24, 12), TZ)
    expect(d.overview.totalTokens).toBe(500 * 165)
  })
})
