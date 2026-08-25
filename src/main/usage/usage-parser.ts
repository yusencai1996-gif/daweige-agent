import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'

/**
 * 使用统计解析(纯函数)——PLAN §2/§6.2。
 * 从 assistant 消息提取 usage 事件;数值异常直接拒绝(不记、不伪造)。
 * 费用字段(pi usage.cost)在这里就被丢弃:口径=不落库不传输。
 */

/** 解析成功的 usage 事件(store 层输入)。 */
export interface ParsedUsageEvent {
  readonly sourceEntryId: string
  readonly sessionId: string
  readonly provider: string
  readonly modelId: string
  readonly responseModelId: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cacheWrite1hTokens: number | null
  readonly totalTokens: number
  readonly occurredAtMs: number
  readonly localDate: string
  /** 归日时使用的 IANA 时区(与 localDate 配对存档,跨时区迁移也不跳日)。 */
  readonly timezoneId: string
  readonly stopReason: string
}

/** 非 assistant / usage 缺失 / 数值非法 → undefined(调用方静默跳过)。 */
export function parseAssistantUsage(input: {
  sourceEntryId: string
  sessionId: string
  message: AgentMessage
  timeZone: string
  /** 回填传 entry 级时间兜底(message.timestamp 缺失时不归到"今天");live 不传。 */
  occurredAtFallbackMs?: number
}): ParsedUsageEvent | undefined {
  const { sourceEntryId, sessionId, message, timeZone } = input
  if (message.role !== 'assistant') return undefined
  const usage = pickUsage(message)
  if (!usage) return undefined

  const inputTokens = safeCount(usage.input)
  const outputTokens = safeCount(usage.output)
  const cacheReadTokens = safeCount(usage.cacheRead)
  const cacheWriteTokens = safeCount(usage.cacheWrite)
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined
  }
  const cacheWrite1h = safeCount(usage.cacheWrite1h)

  // totalTokens 口径以四项之和为准:pi 归一值不一致时按四项重算,不采用上报值;
  // 和仍须是安全整数(四个安全整数之和可能越界,codex 复审 S-01)
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (!Number.isSafeInteger(totalTokens)) return undefined

  const messageTimestamp =
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : input.occurredAtFallbackMs
  if (messageTimestamp === undefined) return undefined
  // 超出 Date 有效范围的时间戳会让 Intl 归日抛异常,直接拒绝(codex 复审 B-02)
  if (Math.abs(messageTimestamp) > 8.64e15) return undefined
  const occurredAtMs = messageTimestamp

  const provider = typeof message.provider === 'string' ? message.provider : ''
  const modelId = typeof message.model === 'string' ? message.model : ''
  if (!provider || !modelId) return undefined

  return {
    sourceEntryId,
    sessionId,
    provider,
    modelId,
    responseModelId:
      typeof message.responseModel === 'string' && message.responseModel
        ? message.responseModel
        : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: cacheWrite1h ?? null,
    totalTokens,
    occurredAtMs,
    localDate: localDateFor(occurredAtMs, timeZone),
    timezoneId: timeZone,
    stopReason: typeof message.stopReason === 'string' ? message.stopReason : '',
  }
}

/** 会话时间跨度记录(store 层 upsert 输入);来自 user/assistant 任意持久化消息。 */
export interface MessageSpanInput {
  readonly sessionId: string
  readonly atMs: number
}

function pickUsage(message: { usage?: unknown }): Usage | undefined {
  const usage = message.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  return usage as Usage
}

/** 非负有限安全整数才放行;其余 undefined。 */
function safeCount(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value) || value < 0) return undefined
  if (!Number.isSafeInteger(value)) return undefined
  return value
}

/** IANA 时区下的自然日(YYYY-MM-DD);用 en-CA locale 取 ISO 形态,不碰固定 offset。 */
export function localDateFor(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : new Date(ms).toISOString().slice(0, 10)
}

/** 当前系统 IANA 时区;取不到回退 UTC。 */
export function currentIanaTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return tz && typeof tz === 'string' ? tz : 'UTC'
}
