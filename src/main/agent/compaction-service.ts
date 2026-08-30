import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionEntry,
  type CompactionPreparation,
  type CompactResult,
  type Session,
} from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import type { ThinkingLevel } from '../../shared/domain/settings'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { UsageRecorder } from '../usage/usage-service'
import {
  COMPACTION_EXECUTION_SETTINGS,
  triggerReserveTokens,
} from './compaction-policy'

export interface CompactionModelAccess {
  completeSimple: Models['completeSimple']
}

export interface CompactionTarget {
  readonly sessionId: string
  readonly session: Session<SqliteSessionMetadata>
  readonly model: Model<Api>
  /**
   * 当前内存上下文快照。execute 以 DB entries 为权威(重新 findEntriesOnBranch),
   * 本字段仅供诊断对照与测试构造;压缩结果经 replaceMessages 写回内存。
   */
  readonly messages: readonly AgentMessage[]
  replaceMessages(messages: AgentMessage[]): void
}

export interface CompactionServiceDeps {
  readonly models: CompactionModelAccess
  readonly emitEvent: (event: AgentPushEvent) => void
  readonly usageRecorder?: UsageRecorder
  readonly thinkingLevel?: () => ThinkingLevel | undefined
  /** 测试注入点；生产始终使用 pi 原生实现。 */
  readonly prepare?: typeof prepareCompaction
  readonly runCompact?: typeof compact
}

export interface CompactionOutcome {
  readonly entry: CompactionEntry
  readonly tokensAfter: number
}

export interface CompactionRunner {
  execute(target: CompactionTarget, signal: AbortSignal): Promise<CompactionOutcome | undefined>
}

/**
 * shouldStopAfterTurn 使用的纯计算：只根据当前上下文与模型窗口决定是否停在 turn 边界。
 * pi 的 shouldCompact 是严格大于，因此 80% 整不触发，80.1% 才触发。
 */
export function shouldRequestCompaction(
  messages: readonly AgentMessage[],
  contextWindow: number,
): boolean {
  try {
    const tokens = estimateContextTokens([...messages]).tokens
    return shouldCompact(tokens, contextWindow, {
      ...COMPACTION_EXECUTION_SETTINGS,
      reserveTokens: triggerReserveTokens(contextWindow),
    })
  } catch {
    return false
  }
}

export class CompactionService implements CompactionRunner {
  constructor(private readonly deps: CompactionServiceDeps) {}

  /**
   * 生成摘要后先提交原生 CompactionEntry；只有提交成功才替换 Agent state 并推成功事件。
   */
  async execute(target: CompactionTarget, signal: AbortSignal): Promise<CompactionOutcome | undefined> {
    const entries = await target.session.findEntriesOnBranch({ order: 'oldestFirst' })
    throwIfAborted(signal)

    const prepared = (this.deps.prepare ?? prepareCompaction)(
      entries,
      COMPACTION_EXECUTION_SETTINGS,
    )
    if (!prepared.ok) throw prepared.error
    if (!prepared.value) return undefined

    const result = await (this.deps.runCompact ?? compact)(
      prepared.value as CompactionPreparation,
      this.deps.models as Models,
      target.model,
      undefined,
      signal,
      normalizedThinkingLevel(this.deps.thinkingLevel?.()),
    )
    if (!result.ok) throw result.error
    throwIfAborted(signal)

    const compacted = result.value as CompactResult
    const entry = await target.session.appendEntry<CompactionEntry>(
      {
        type: 'compaction',
        id: target.session.idGenerator.next(),
        summary: compacted.summary,
        retainedTail: compacted.retainedTail,
        tokensBefore: compacted.tokensBefore,
        ...(compacted.usage ? { usage: compacted.usage } : {}),
        details: {
          ...(asDetails(compacted.details)),
          daweige: {
            providerId: providerOf(target.model),
            modelId: target.model.id,
          },
        },
      },
      'main',
    )

    // appendEntry 成功之后，entry 已是 SQLite 权威事实；由同一事实投影新上下文。
    const context = buildSessionContext([...entries, entry])
    const nextMessages = context.messages
    const tokensAfter = estimateContextTokens(nextMessages).tokens
    target.replaceMessages(nextMessages)

    try {
      this.deps.usageRecorder?.recordCompactionEntry({
        sourceEntryId: entry.id,
        sessionId: target.sessionId,
        entry,
      })
    } catch (error) {
      console.error('[agent] compaction usage 记录异常(已忽略):', error)
    }

    this.deps.emitEvent({
      type: 'context_compacted',
      sessionId: target.sessionId,
      notice: {
        kind: 'compaction',
        id: entry.id,
        role: 'system',
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        tokensAfter,
        createdAt: entry.timestamp,
      },
      contextUsage: { usedTokens: tokensAfter, contextWindow: target.model.contextWindow },
    })
    return { entry, tokensAfter }
  }
}

function normalizedThinkingLevel(level: ThinkingLevel | undefined) {
  return level && level !== 'off' ? level : undefined
}

function providerOf(model: Model<Api>): string {
  return (model as Model<Api> & { provider?: string }).provider ?? ''
}

function asDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('压缩已取消', 'AbortError')
}
