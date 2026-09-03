import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UsageDashboard } from '../../shared/domain/usage'
import type { AgentRunUsage } from '../../shared/domain/manager'
import { localDateFor, type ParsedUsageEvent } from './usage-parser'

/**
 * 使用统计存储(PLAN §3)。
 * userData/data/usage.sqlite(独立于 pi 会话库);node:sqlite 同步 API。
 * 所有读写过同一 Promise 队列——写互斥、查询取到的是队列一致的快照。
 * source_entry_id 主键 = 幂等键:live 记录、重试、历史回填三者天然去重。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  source_entry_id      TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  response_model_id    TEXT,
  input_tokens         INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens        INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens    INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens   INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0),
  total_tokens         INTEGER NOT NULL CHECK (total_tokens >= 0),
  occurred_at_ms       INTEGER NOT NULL,
  local_date           TEXT NOT NULL,
  timezone_id          TEXT NOT NULL,
  stop_reason          TEXT NOT NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('live', 'backfill')),
  ingested_at_ms       INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_events_date
  ON usage_events(local_date);

CREATE INDEX IF NOT EXISTS idx_usage_events_model_date
  ON usage_events(provider, response_model_id, model_id, local_date);

CREATE INDEX IF NOT EXISTS idx_usage_events_session
  ON usage_events(session_id);

-- ⑤审整改:活跃时长聚合按 (session_id, occurred_at_ms, source_entry_id) 全表排序,
-- 组合索引让 dashboard 免全表物化排序(数据量翻倍前的预防)
CREATE INDEX IF NOT EXISTS idx_usage_events_session_time
  ON usage_events(session_id, occurred_at_ms, source_entry_id);

CREATE TABLE IF NOT EXISTS usage_session_spans (
  session_id            TEXT PRIMARY KEY,
  first_message_at_ms   INTEGER NOT NULL,
  last_message_at_ms    INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  CHECK (last_message_at_ms >= first_message_at_ms)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`

const ACTIVITY_DAYS = 365
const TREND_DAYS = 30
export const ACTIVE_SESSION_GAP_MS = 30 * 60 * 1000

export interface UsageActivityRow {
  readonly sessionId: string
  readonly occurredAtMs: number
}

/** 纯函数版本供边界单测；输入可乱序，重复时间戳贡献 0。 */
export function computeLongestActiveSessionDuration(
  rows: readonly UsageActivityRow[],
  maxGapMs = ACTIVE_SESSION_GAP_MS,
): number {
  const sorted = [...rows].sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.occurredAtMs - b.occurredAtMs,
  )
  return accumulateLongestActiveSessionDuration(sorted, maxGapMs)
}

function accumulateLongestActiveSessionDuration(
  rows: Iterable<UsageActivityRow>,
  maxGapMs: number,
): number {
  let currentSession: string | undefined
  let previousAt = 0
  let currentDuration = 0
  let longest = 0
  for (const row of rows) {
    if (row.sessionId !== currentSession) {
      longest = Math.max(longest, currentDuration)
      currentSession = row.sessionId
      previousAt = row.occurredAtMs
      currentDuration = 0
      continue
    }
    const delta = row.occurredAtMs - previousAt
    if (delta >= 0 && delta <= maxGapMs) currentDuration += delta
    previousAt = row.occurredAtMs
  }
  return Math.max(longest, currentDuration)
}

export class UsageStore {
  private readonly db: DatabaseSync
  /** 读写统一串行队列(memory-store 同款模式)。 */
  private chain: Promise<unknown> = Promise.resolve()
  /** drainAndClose 后拒绝新写(退出瞬间 abort 流仍可能触发记录)。 */
  private closed = false

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
  }

  private enqueue<T>(op: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('usage store 已关闭(应用退出中),本次写入放弃'))
    }
    const next = this.chain.then(op, op)
    this.chain = next.catch(() => {})
    return next
  }

  /** 批量幂等插入;返回实际新增行数(重复 source_entry_id 被忽略)。 */
  insertEvents(events: readonly ParsedUsageEvent[], sourceKind: 'live' | 'backfill'): Promise<number> {
    if (events.length === 0) return Promise.resolve(0)
    return this.enqueue(() => {
      const now = Date.now()
      let inserted = 0
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const stmt = this.db.prepare(`
          INSERT OR IGNORE INTO usage_events (
            source_entry_id, session_id, provider, model_id, response_model_id,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cache_write_1h_tokens, total_tokens, occurred_at_ms, local_date,
            timezone_id, stop_reason, source_kind, ingested_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const e of events) {
          const result = stmt.run(
            e.sourceEntryId,
            e.sessionId,
            e.provider,
            e.modelId,
            e.responseModelId,
            e.inputTokens,
            e.outputTokens,
            e.cacheReadTokens,
            e.cacheWriteTokens,
            e.cacheWrite1hTokens,
            e.totalTokens,
            e.occurredAtMs,
            e.localDate,
            e.timezoneId,
            e.stopReason,
            sourceKind,
            now,
          ) as { changes: number | bigint }
          inserted += Number(result.changes)
        }
        this.db.exec('COMMIT')
        return inserted
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    })
  }

  /** @deprecated 0.5.0 起不再读写；仅保留表/方法供老库兼容测试。 */
  upsertSessionSpan(sessionId: string, atMs: number): Promise<void> {
    return this.enqueue(() => {
      this.db
        .prepare(
          `INSERT INTO usage_session_spans (session_id, first_message_at_ms, last_message_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             first_message_at_ms = MIN(first_message_at_ms, excluded.first_message_at_ms),
             last_message_at_ms  = MAX(last_message_at_ms,  excluded.last_message_at_ms),
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(sessionId, atMs, atMs, Date.now())
    }).then(() => undefined)
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.enqueue(() => {
      this.db
        .prepare(
          `INSERT INTO usage_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value)
    }).then(() => undefined)
  }

  getMeta(key: string): Promise<string | null> {
    return this.enqueue(() => {
      const row = this.db.prepare('SELECT value FROM usage_meta WHERE key = ?').get(key)
      return (row as { value: string } | undefined)?.value ?? null
    })
  }

  /** 整页统计快照:四类聚合在只读事务内完成——跨进程并发写下也保证同源一致(codex 复审 B-03)。 */
  buildDashboard(nowMs: number, timeZone: string): Promise<UsageDashboard> {
    return this.enqueue(() => {
      this.db.exec('BEGIN DEFERRED')
      try {
        const snapshot = this.computeDashboard(nowMs, timeZone)
        this.db.exec('COMMIT')
        return snapshot
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    })
  }

  /** 按 internal session 聚合派活用量。参数分批绑定，空会话也显式补零。 */
  getSessionTotals(sessionIds: readonly string[]): Promise<Map<string, AgentRunUsage>> {
    const unique = [...new Set(sessionIds)]
    const zero = (): AgentRunUsage => ({
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    })
    if (unique.length === 0) return Promise.resolve(new Map())
    return this.enqueue(() => {
      const result = new Map(unique.map((id) => [id, zero()]))
      const batchSize = 500
      for (let offset = 0; offset < unique.length; offset += batchSize) {
        const batch = unique.slice(offset, offset + batchSize)
        const placeholders = batch.map(() => '?').join(',')
        const rows = this.db
          .prepare(
            `SELECT session_id AS id, COUNT(*) AS rounds,
                    COALESCE(SUM(input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM usage_events WHERE session_id IN (${placeholders}) GROUP BY session_id`,
          )
          .all(...batch) as Array<Record<string, string | number>>
        for (const row of rows) {
          result.set(String(row.id), {
            rounds: Number(row.rounds),
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens),
            cacheReadTokens: Number(row.cache_read_tokens),
            cacheWriteTokens: Number(row.cache_write_tokens),
            totalTokens: Number(row.total_tokens),
          })
        }
      }
      return result
    })
  }

  /** 队列排空后关闭(应用退出前调用);之后的写入直接放弃。 */
  drainAndClose(): Promise<void> {
    this.closed = true
    return this.chain.then(() => {
      this.db.close()
    })
  }

  // ---------- 聚合实现(同步,只在队列内调用) ----------

  private computeDashboard(nowMs: number, timeZone: string): UsageDashboard {
    const today = localDateFor(nowMs, timeZone)
    const activityDates = calendarSequenceBack(today, ACTIVITY_DAYS - 1)
    const fromDate = activityDates[0] ?? today
    const trendDates = activityDates.slice(ACTIVITY_DAYS - TREND_DAYS)

    const totalRow = this.db.prepare('SELECT SUM(total_tokens) AS s FROM usage_events').get() as
      | { s: number | null }
      | undefined
    const totalTokens = totalRow?.s ?? 0

    const peakRow = this.db
      .prepare(
        'SELECT MAX(day_total) AS m FROM (SELECT SUM(total_tokens) AS day_total FROM usage_events GROUP BY local_date)',
      )
      .get() as { m: number | null } | undefined
    const peakDailyTokens = peakRow?.m ?? 0

    const activityRows = this.db
      .prepare(
        `SELECT session_id AS sessionId, occurred_at_ms AS occurredAtMs
         FROM usage_events
         ORDER BY session_id ASC, occurred_at_ms ASC, source_entry_id ASC`,
      )
      .iterate() as Iterable<UsageActivityRow>
    const longestActiveSessionDurationMs = accumulateLongestActiveSessionDuration(
      activityRows,
      ACTIVE_SESSION_GAP_MS,
    )

    const streaks = this.computeStreaks(today)

    // 365 日活动桶
    const activityMap = new Map<string, number>()
    for (const row of this.db
      .prepare(
        'SELECT local_date AS d, SUM(total_tokens) AS s FROM usage_events WHERE local_date >= ? GROUP BY local_date',
      )
      .all(fromDate) as { d: string; s: number }[]) {
      activityMap.set(row.d, row.s)
    }
    const activityDays = activityDates.map((d) => ({ date: d, totalTokens: activityMap.get(d) ?? 0 }))

    // 30 日趋势(per provider+effective model)
    const trendFrom = trendDates[0] ?? fromDate
    const series = new Map<string, { provider: string; model: string; values: number[] }>()
    const trendIndex = new Map(trendDates.map((d, i) => [d, i]))
    for (const row of this.db
      .prepare(
        `SELECT provider AS p, COALESCE(response_model_id, model_id) AS m,
                local_date AS d, SUM(total_tokens) AS s
         FROM usage_events WHERE local_date >= ? GROUP BY provider, m, local_date`,
      )
      .all(trendFrom) as { p: string; m: string; d: string; s: number }[]) {
      const key = `${row.p}\u0000${row.m}`
      let series_ = series.get(key)
      if (!series_) {
        series_ = { provider: row.p, model: row.m, values: new Array<number>(TREND_DAYS).fill(0) }
        series.set(key, series_)
      }
      const idx = trendIndex.get(row.d)
      if (idx !== undefined) series_.values[idx] = row.s
    }

    // 模型总量(降序)
    const modelItems = (
      this.db
        .prepare(
          `SELECT provider AS p, COALESCE(response_model_id, model_id) AS m, SUM(total_tokens) AS s
           FROM usage_events GROUP BY provider, m ORDER BY s DESC`,
        )
        .all() as { p: string; m: string; s: number }[]
    ).map((r) => ({ provider: r.p, model: r.m, totalTokens: r.s }))

    return {
      schemaVersion: 2,
      generatedAt: nowMs,
      timeZone,
      // 全零行(provider 未回 usage)不构成"有数据":以累计 token 为准
      hasData: totalTokens > 0,
      overview: {
        totalTokens,
        peakDailyTokens,
        longestActiveSessionDurationMs,
        currentStreakDays: streaks.current,
        longestStreakDays: streaks.longest,
      },
      activity: { fromDate, toDate: today, days: activityDays },
      trend: {
        fromDate: trendFrom,
        toDate: today,
        dates: trendDates,
        series: [...series.values()],
      },
      models: { totalTokens, items: modelItems },
      // 0.3.0 契约过渡:按 run 归集由后端线接入(PLAN §9);子 agent token 已含在上面四区
      delegations: { totalTokens: 0, runs: [] },
    }
  }

  /** 连续使用天数:current 必须以今天结尾(今天无用量=0);longest 取全史。
   *  只认 total_tokens > 0 的日子:provider 未回 usage 的全零行不算"用过"。 */
  private computeStreaks(today: string): { current: number; longest: number } {
    const dates = (
      this.db
        .prepare(
          'SELECT DISTINCT local_date AS d FROM usage_events WHERE total_tokens > 0 ORDER BY d ASC',
        )
        .all() as { d: string }[]
    ).map((r) => r.d)
    if (dates.length === 0) return { current: 0, longest: 0 }

    let longest = 1
    let run = 1
    for (let i = 1; i < dates.length; i++) {
      const prev = dates[i - 1]
      const curr = dates[i]
      if (!prev || !curr) continue
      if (dayDiff(prev, curr) === 1) {
        run += 1
        longest = Math.max(longest, run)
      } else {
        run = 1
      }
    }

    let current = 0
    if (dates[dates.length - 1] === today) {
      current = 1
      for (let i = dates.length - 1; i > 0; i--) {
        const curr = dates[i]
        const prev = dates[i - 1]
        if (!curr || !prev) break
        if (dayDiff(prev, curr) === 1) current += 1
        else break
      }
    }
    return { current, longest: Math.max(longest, current) }
  }
}

/** 日历字符串减法(UTC 算术,与时区无关):from 往前 count 天的序列(升序返回)。 */
function calendarSequenceBack(fromDate: string, count: number): string[] {
  const base = Date.parse(`${fromDate}T00:00:00Z`)
  const out: string[] = []
  for (let i = count; i >= 0; i--) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

/** 两个 YYYY-MM-DD 的日历天数差(a<b 为正)。 */
function dayDiff(a: string, b: string): number {
  const diff = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)
  return Math.round(diff / 86_400_000)
}
