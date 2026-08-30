/**
 * A-25(0.5.0):派活用量分段横条图的数据层(纯函数,无依赖 React,可单测)。
 *
 * 口径(PLAN §3.2):
 * - 四项固定顺序:输入 → 输出 → 缓存读 → 缓存写;
 * - 分母 = 四项之和,不盲信可能漂移的 totalTokens;
 * - 四项全零返回空轨道,不除零;
 * - 数值保持原整数,百分比仅用于布局;width 由组件按 flex-grow 比例分配;
 * - tooltip/aria 用完整整数(千分位),不缩写。
 */

import { formatTokensFull } from '../usage/usage-format'

export type TokenSegmentKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

export interface TokenSegment {
  readonly key: TokenSegmentKey
  /** 中文短名:输入/输出/缓存读/缓存写。 */
  readonly label: string
  /** 原整数(非有限/负数按 0 计,防御后端脏数据)。 */
  readonly value: number
  /** 占比 ∈ [0,1];分母为四项之和;全零时四项皆为 0,不除零。 */
  readonly ratio: number
}

export interface TokenSegmentData {
  /** 固定四项顺序,含 0 值项(是否画 0 宽段由组件决定,数据层不藏数据)。 */
  readonly segments: readonly TokenSegment[]
  /** 四项之和(可能与 totalTokens 不一致,画bar以它为准)。 */
  readonly total: number
  /** 四项全零 → 空轨道。 */
  readonly empty: boolean
}

/** 分项横条的输入面:只取四项,故意不收 totalTokens,从签名上杜绝拿它当分母。 */
export interface TokenSegmentUsageInput {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** 非有限/负数一律按 0 计;usage 由后端整数落库,这里只做防御。 */
function sanitize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value)
}

/** 组装四段:固定顺序、真实比例、全零不除零。 */
export function buildTokenSegments(usage: TokenSegmentUsageInput): TokenSegmentData {
  const values: readonly (readonly [TokenSegmentKey, string, number])[] = [
    ['input', '输入', sanitize(usage.inputTokens)],
    ['output', '输出', sanitize(usage.outputTokens)],
    ['cacheRead', '缓存读', sanitize(usage.cacheReadTokens)],
    ['cacheWrite', '缓存写', sanitize(usage.cacheWriteTokens)],
  ]
  const total = values.reduce((sum, [, , v]) => sum + v, 0)
  const segments: TokenSegment[] = values.map(([key, label, value]) => ({
    key,
    label,
    value,
    ratio: total > 0 ? value / total : 0,
  }))
  return { segments, total, empty: total === 0 }
}

/** 单段 tooltip:完整整数,永不缩写(「输入 48,200 tokens」)。 */
export function tokenSegmentTip(segment: TokenSegment): string {
  return `${segment.label} ${formatTokensFull(segment.value)} tokens`
}

/** 整根横条的 aria-label:四项完整整数 + 合计;全零照实说。 */
export function tokenSegmentsAriaLabel(data: TokenSegmentData): string {
  if (data.empty) return '用量分项:输入、输出、缓存读、缓存写均为 0 tokens'
  const parts = data.segments.map((s) => `${s.label} ${formatTokensFull(s.value)}`)
  return `用量分项:${parts.join(' · ')},合计 ${formatTokensFull(data.total)} tokens`
}
