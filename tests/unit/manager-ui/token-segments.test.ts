/**
 * A-25(0.5.0):token-segments 纯函数单测(PLAN §3.3)。
 * 覆盖:四项比例 1:2:3:4 / 单项独占 / 全零不除零 / 大整数格式化 / 分项和≠totalTokens 仍按分项。
 */
import { describe, expect, it } from 'vitest'
import {
  buildTokenSegments,
  tokenSegmentTip,
  tokenSegmentsAriaLabel,
} from '../../../src/renderer/features/manager/token-segments'

describe('buildTokenSegments', () => {
  it('四项固定顺序:输入/输出/缓存读/缓存写', () => {
    const data = buildTokenSegments({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    })
    expect(data.segments.map((s) => s.key)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(data.segments.map((s) => s.label)).toEqual(['输入', '输出', '缓存读', '缓存写'])
  })

  it('比例 1:2:3:4,分母=四项之和', () => {
    const data = buildTokenSegments({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
    })
    expect(data.total).toBe(1000)
    expect(data.empty).toBe(false)
    expect(data.segments.map((s) => s.ratio)).toEqual([0.1, 0.2, 0.3, 0.4])
    // 数值保持原整数
    expect(data.segments.map((s) => s.value)).toEqual([100, 200, 300, 400])
  })

  it('单项独占:该项 ratio=1,其余 0', () => {
    const data = buildTokenSegments({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 130_022,
      cacheWriteTokens: 0,
    })
    expect(data.total).toBe(130_022)
    expect(data.segments[2]!.ratio).toBe(1)
    expect(data.segments[0]!.ratio).toBe(0)
    expect(data.segments[1]!.ratio).toBe(0)
    expect(data.segments[3]!.ratio).toBe(0)
  })

  it('全零:空轨道、total=0、ratio 全 0 不除零', () => {
    const data = buildTokenSegments({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(data.empty).toBe(true)
    expect(data.total).toBe(0)
    for (const s of data.segments) {
      expect(s.ratio).toBe(0)
      expect(Number.isNaN(s.ratio)).toBe(false)
    }
  })

  it('脏数据防御:负数/NaN/Infinity 按 0 计', () => {
    const data = buildTokenSegments({
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      cacheWriteTokens: 80,
    })
    expect(data.total).toBe(80)
    expect(data.segments[3]!.ratio).toBe(1)
    expect(data.segments.slice(0, 3).every((s) => s.value === 0 && s.ratio === 0)).toBe(true)
  })

  it('分项和与 totalTokens 不一致时仍按分项画图(签名层面不收 totalTokens)', () => {
    // totalTokens=999_999 漂移,分母仍用四项之和 200_552
    const data = buildTokenSegments({
      inputTokens: 48_200,
      outputTokens: 12_930,
      cacheReadTokens: 130_022,
      cacheWriteTokens: 9_400,
    })
    expect(data.total).toBe(200_552)
    expect(data.segments[0]!.ratio).toBeCloseTo(48_200 / 200_552, 10)
    expect(data.segments[2]!.ratio).toBeCloseTo(130_022 / 200_552, 10)
  })
})

describe('tooltip / aria-label', () => {
  it('单段 tooltip 用完整整数(千分位),不缩写', () => {
    const data = buildTokenSegments({
      inputTokens: 48_200,
      outputTokens: 12_930,
      cacheReadTokens: 130_022,
      cacheWriteTokens: 9_400,
    })
    expect(tokenSegmentTip(data.segments[2]!)).toBe('缓存读 130,022 tokens')
  })

  it('aria-label 含四项完整整数与合计', () => {
    const data = buildTokenSegments({
      inputTokens: 48_200,
      outputTokens: 12_930,
      cacheReadTokens: 130_022,
      cacheWriteTokens: 9_400,
    })
    const label = tokenSegmentsAriaLabel(data)
    expect(label).toBe('用量分项:输入 48,200 · 输出 12,930 · 缓存读 130,022 · 缓存写 9,400,合计 200,552 tokens')
  })

  it('全零 aria-label 照实说,不编造', () => {
    const data = buildTokenSegments({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(tokenSegmentsAriaLabel(data)).toBe('用量分项:输入、输出、缓存读、缓存写均为 0 tokens')
  })

  it('大整数格式化:亿级不缩写、千分位完整', () => {
    const data = buildTokenSegments({
      inputTokens: 123_456_789,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(tokenSegmentTip(data.segments[0]!)).toBe('输入 123,456,789 tokens')
    expect(tokenSegmentsAriaLabel(data)).toContain('合计 123,456,789 tokens')
  })
})
