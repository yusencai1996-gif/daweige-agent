import type { AgentMessage, CompactionEntry } from '@earendil-works/pi-agent-core'
import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import type { UsageDashboard } from '../../shared/domain/usage'
import type { AgentRunSummary } from '../../shared/domain/manager'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { UsageStore } from './usage-store'
import {
  currentIanaTimeZone,
  parseAssistantUsage,
  parseCompactionUsage,
  parseUsageBlock,
  type ParsedUsageEvent,
} from './usage-parser'
import type { UsageEntryRow } from '../storage/session-repository'

/**
 * 使用统计服务(PLAN §6.2,2026-08-24 复审整改版)。
 * - live:agent 消息流挂记录点,fire-and-forget,失败只记日志绝不影响聊天/审批;
 * - 回填:只读遍历 pi 会话库的 message entries(不 open Session、不取 writer lease),
 *   每批 500 条提交一次并让出事件循环;幂等键 = sessionId:entryId(pi fork 会复用
 *   entry id,加会话前缀防未来分支功能静默丢统计);
 * - dashboard:等回填完成后返回完整快照(页面打开即完整数据)。
 */

/** AgentService 依赖的窄接口(单测可注入 mock)。 */
export interface UsageRecorder {
  recordAssistantMessage(input: {
    sourceEntryId: string
    sessionId: string
    message: AgentMessage
  }): void
  recordCompactionEntry(input: {
    sourceEntryId: string
    sessionId: string
    entry: CompactionEntry
  }): void
  recordAuxiliaryUsage?(input: {
    sourceId: string
    sessionId: string
    model: Model<Api>
    usage: Usage
    occurredAt: number
    stopReason: 'memory-consolidation'
  }): Promise<void>
}

export interface UsageServiceDeps {
  emitEvent: (event: AgentPushEvent) => void
  /** 惰性分页只读遍历 pi 会话库 message entries(SessionRepository.iterateMessageEntries;测试可传数组)。 */
  iterateUsageEntries: () => Iterable<UsageEntryRow>
  logError: (message: string, error: unknown) => void
}

const BACKFILL_BATCH_SIZE = 500

export class UsageService implements UsageRecorder {
  private backfillPromise: Promise<void> | undefined
  private delegationProvider: (() => Promise<readonly AgentRunSummary[]>) | undefined

  constructor(
    private readonly store: UsageStore,
    private readonly deps: UsageServiceDeps,
  ) {}

  setDelegationProvider(provider: () => Promise<readonly AgentRunSummary[]>): void {
    this.delegationProvider = provider
  }

  // ---------- live 记录(agent 事件流挂钩) ----------

  recordAssistantMessage(input: {
    sourceEntryId: string
    sessionId: string
    message: AgentMessage
  }): void {
    let event: ParsedUsageEvent | undefined
    try {
      event = parseAssistantUsage({ ...input, timeZone: currentIanaTimeZone() })
    } catch (error) {
      this.deps.logError('usage 解析异常(已跳过)', error)
      return
    }
    if (!event) return
    void this.store
      .insertEvents(
        [{ ...event, sourceEntryId: idempotencyKey(input.sessionId, input.sourceEntryId) }],
        'live',
      )
      .then((inserted) => {
        if (inserted > 0) this.notifyUpdated()
      })
      .catch((error) => this.deps.logError('usage live 记录失败(不影响聊天)', error))
  }

  recordCompactionEntry(input: {
    sourceEntryId: string
    sessionId: string
    entry: CompactionEntry
  }): void {
    let event: ParsedUsageEvent | undefined
    try {
      event = parseCompactionUsage({ ...input, timeZone: currentIanaTimeZone() })
    } catch (error) {
      this.deps.logError('compaction usage 解析异常(已跳过)', error)
      return
    }
    if (!event) return
    void this.store
      .insertEvents(
        [{ ...event, sourceEntryId: idempotencyKey(input.sessionId, input.sourceEntryId) }],
        'live',
      )
      .then((inserted) => {
        if (inserted > 0) this.notifyUpdated()
      })
      .catch((error) => this.deps.logError('compaction usage live 记录失败(不影响聊天)', error))
  }

  async recordAuxiliaryUsage(input: {
    sourceId: string
    sessionId: string
    model: Model<Api>
    usage: Usage
    occurredAt: number
    stopReason: 'memory-consolidation'
  }): Promise<void> {
    let event: ParsedUsageEvent | undefined
    try {
      event = parseUsageBlock({
        sourceEntryId: idempotencyKey(input.sessionId, input.sourceId),
        sessionId: input.sessionId,
        usage: input.usage,
        provider: String((input.model as { provider?: unknown }).provider ?? ''),
        modelId: input.model.id,
        responseModelId: null,
        occurredAtMs: input.occurredAt,
        timeZone: currentIanaTimeZone(),
        stopReason: input.stopReason,
      })
    } catch (error) {
      this.deps.logError('auxiliary usage 解析异常（已跳过）', error)
      return
    }
    if (!event) return
    await this.store.insertEvents([event], 'live').then((inserted) => {
      if (inserted > 0) this.notifyUpdated()
    })
  }

  private notifyUpdated(): void {
    this.deps.emitEvent({ type: 'usage_updated', generatedAt: Date.now() })
  }

  // ---------- 历史回填 ----------

  /** 启动后调用一次;幂等(主键去重),失败下次启动自然重扫。 */
  startBackfill(): void {
    if (this.backfillPromise) return
    this.backfillPromise = this.runBackfill()
  }

  private async runBackfill(): Promise<void> {
    try {
      const timeZone = currentIanaTimeZone()
      const batch: ParsedUsageEvent[] = []
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return
        const inserted = await this.store.insertEvents(batch, 'backfill')
        batch.length = 0
        if (inserted > 0) this.notifyUpdated()
        // 让出事件循环:批量事务不长时间占住主线程(codex 复审 B-01)
        await new Promise((resolve) => setImmediate(resolve))
      }
      for (const row of this.deps.iterateUsageEntries()) {
        // 行级隔离(codex 复审 B-02):一条坏数据只丢自己,不阻断其后所有历史回填
        try {
          if (row.type === 'message') {
            const message = row.message as { role?: string; timestamp?: number }
            if (message?.role !== 'assistant') continue
            const parsed = parseAssistantUsage({
              sourceEntryId: idempotencyKey(row.sessionId, row.entryId),
              sessionId: row.sessionId,
              message: row.message as AgentMessage,
              timeZone,
              // message.timestamp 缺失时回退 entry 落库时间,绝不归到"今天"
              occurredAtFallbackMs: row.timestamp,
            })
            if (parsed) batch.push(parsed)
          } else {
            const parsed = parseCompactionUsage({
              sourceEntryId: idempotencyKey(row.sessionId, row.entryId),
              sessionId: row.sessionId,
              entry: row.entry,
              timeZone,
            })
            if (parsed) batch.push(parsed)
          }
        } catch (rowError) {
          this.deps.logError(`usage 回填跳过异常 entry(${row.sessionId}#${row.seq})`, rowError)
        }
        if (batch.length >= BACKFILL_BATCH_SIZE) await flush()
      }
      await flush()
      await this.store.setMeta('backfill_completed_at', new Date().toISOString())
    } catch (error) {
      this.deps.logError('usage 回填整体失败(下次启动重试)', error)
    }
  }

  // ---------- 查询 ----------

  /** 页面数据:等回填完成,保证打开即完整(回填失败不阻塞,返回已有数据)。 */
  async getDashboard(): Promise<UsageDashboard> {
    await this.backfillPromise?.catch(() => {})
    const dashboard = await this.store.buildDashboard(Date.now(), currentIanaTimeZone())
    const runs = await this.delegationProvider?.().catch((error) => {
      this.deps.logError('派活用量查询失败，本次统计页暂不显示派活明细', error)
      return []
    }) ?? []
    return {
      ...dashboard,
      delegations: {
        totalTokens: runs.reduce((sum, run) => sum + run.usage.totalTokens, 0),
        runs,
      },
    }
  }

  async drainAndClose(): Promise<void> {
    await this.backfillPromise?.catch(() => {})
    await this.store.drainAndClose()
  }
}

/** 幂等键:sessionId + entryId。pi fork 会把 entry.id 原样复制到新会话,纯 entryId 会被静默吞掉。 */
function idempotencyKey(sessionId: string, entryId: string): string {
  return `${sessionId}:${entryId}`
}
