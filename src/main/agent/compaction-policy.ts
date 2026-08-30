import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core'

export const COMPACTION_TRIGGER_REMAINING_RATIO = 0.2

export function triggerReserveTokens(contextWindow: number): number {
  const normalizedWindow = Number.isFinite(contextWindow) ? Math.max(0, Math.floor(contextWindow)) : 0
  const ratio = Math.floor(normalizedWindow * COMPACTION_TRIGGER_REMAINING_RATIO)
  // pi 默认 reserve 16384 可能超过小窗口本身(触发点变负=每轮都压缩),cap 到窗口 80%;
  // 真实模型窗口(≥131072)不受影响:20% 份额本就大于 16384。
  return Math.min(
    Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, ratio),
    Math.floor(normalizedWindow * 0.8),
  )
}

/** 摘要预算沿用 pi 默认值，不能随 1M context window 放大。 */
export const COMPACTION_EXECUTION_SETTINGS = DEFAULT_COMPACTION_SETTINGS
