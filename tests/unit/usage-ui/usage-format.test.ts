import { describe, expect, it } from 'vitest'
import {
  formatDurationMs,
  formatPercent,
  formatTokens,
  formatTokensFull,
} from '../../../src/renderer/features/usage/usage-format'

describe('usage-format(使用统计格式化)', () => {
  it('token 中文单位:万/亿缩写,其余千分位', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1234)).toBe('1,234')
    expect(formatTokens(12345)).toBe('1.2万')
    expect(formatTokens(10000)).toBe('1万')
    expect(formatTokens(8_432_168)).toBe('843.2万')
    expect(formatTokens(123_456_789)).toBe('1.23亿')
    expect(formatTokens(200_000_000)).toBe('2亿')
  })

  it('非法值不出 NaN/Infinity', () => {
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokensFull(Number.NaN)).toBe('0')
    expect(formatPercent(Number.NaN)).toBe('0%')
    expect(formatDurationMs(Number.NaN)).toBe('0分钟')
  })

  it('完整整数:tooltip 用,不缩写', () => {
    expect(formatTokensFull(0)).toBe('0')
    expect(formatTokensFull(8_432_168)).toBe('8,432,168')
  })

  it('时长:小时/分钟', () => {
    expect(formatDurationMs(0)).toBe('0分钟')
    expect(formatDurationMs(30_000)).toBe('1分钟内')
    expect(formatDurationMs(35 * 60_000)).toBe('35分钟')
    expect(formatDurationMs(60 * 60_000)).toBe('1小时')
    expect(formatDurationMs(9_360_000)).toBe('2小时36分')
  })

  it('百分比:>=10% 一位小数,否则两位', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.1234)).toBe('12.3%')
    expect(formatPercent(0.0123)).toBe('1.23%')
    expect(formatPercent(1)).toBe('100%')
  })
})
