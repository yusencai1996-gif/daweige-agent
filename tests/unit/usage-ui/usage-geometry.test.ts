import { describe, expect, it } from 'vitest'
import {
  aggregateWeeks,
  columnCenterX,
  columnIndexAt,
  cumulativeDays,
  donutArc,
  donutSegments,
  intensityLevel,
  linePath,
  linePoints,
  modelColorMap,
  modelKey,
  niceCeil,
  tail,
} from '../../../src/renderer/features/usage/usage-geometry'

const days = (values: readonly number[]) =>
  values.map((v, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, totalTokens: v }))

describe('usage-geometry(热力图派生)', () => {
  it('强度分档:零值为 0,非零按峰值四档', () => {
    expect(intensityLevel(0, 100)).toBe(0)
    expect(intensityLevel(10, 0)).toBe(0) // max<=0 兜底
    expect(intensityLevel(25, 100)).toBe(1)
    expect(intensityLevel(50, 100)).toBe(2)
    expect(intensityLevel(75, 100)).toBe(3)
    expect(intensityLevel(100, 100)).toBe(4)
  })

  it('周桶聚合:365 日 → 53 桶,总量守恒', () => {
    const input = Array.from({ length: 365 }, (_, i) => ({
      date: `d${i}`,
      totalTokens: i + 1,
    }))
    const weeks = aggregateWeeks(input)
    expect(weeks.length).toBe(53)
    expect(weeks.reduce((a, w) => a + w.totalTokens, 0)).toBe(
      input.reduce((a, d) => a + d.totalTokens, 0),
    )
    expect(weeks[0]).toMatchObject({ fromDate: 'd0', toDate: 'd6' })
    // 最后一桶只有 1 天(365 = 52*7 + 1)
    expect(weeks[52]).toMatchObject({ fromDate: 'd364', toDate: 'd364' })
  })

  it('累计:升序运行累加,末值=总量', () => {
    const result = cumulativeDays(days([10, 0, 5, 15]))
    expect(result.map((d) => d.totalTokens)).toEqual([10, 10, 15, 30])
  })
})

describe('usage-geometry(趋势折线)', () => {
  it('tail:近 7 日 = 尾 7 项', () => {
    expect(tail([1, 2, 3, 4, 5, 6, 7, 8], 7)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(tail([1, 2], 7)).toEqual([1, 2])
    expect(tail([], 7)).toEqual([])
  })

  it('坐标:空序列/单点/全零不产生 NaN', () => {
    expect(linePoints([], 640, 220)).toEqual([])

    const single = linePoints([50], 640, 220)
    expect(single.length).toBe(1)
    expect(single[0]!.x).toBeCloseTo(320, 0)

    const zeros = linePoints([0, 0, 0], 640, 220)
    for (const p of zeros) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    // 全零贴底:y 相同且为绘图区底部
    expect(new Set(zeros.map((p) => p.y)).size).toBe(1)
  })

  it('坐标:最大值顶到绘图区上边', () => {
    const pts = linePoints([0, 100], 640, 220, 8, 12)
    expect(pts[1]!.y).toBeCloseTo(12, 5)
    expect(pts[0]!.y).toBeCloseTo(208, 5)
  })

  it('坐标:maxOverride 共享刻度,小系列不再顶到上边', () => {
    // 共享上限 200:值 100 只到半高,值 50 到 1/4 高
    const pts = linePoints([0, 50, 100], 640, 220, 8, 12, 200)
    expect(pts[2]!.y).toBeCloseTo(12 + 196 * 0.5, 5)
    expect(pts[1]!.y).toBeCloseTo(12 + 196 * 0.75, 5)
    expect(pts[0]!.y).toBeCloseTo(208, 5)
  })

  it('坐标:maxOverride 为 0/NaN/负数时回落自身峰值,不出 NaN', () => {
    for (const bad of [0, Number.NaN, -5]) {
      const pts = linePoints([0, 100], 640, 220, 8, 12, bad)
      expect(pts[1]!.y).toBeCloseTo(12, 5)
      for (const p of pts) expect(Number.isFinite(p.y)).toBe(true)
    }
    // 全零 + 共享上限:贴底不除零
    const zeros = linePoints([0, 0], 640, 220, 8, 12, 100)
    expect(new Set(zeros.map((p) => p.y)).size).toBe(1)
  })

  it('path:空→空串,非空以 M 开头', () => {
    expect(linePath([])).toBe('')
    expect(linePath(linePoints([1, 2, 3], 640, 220))).toMatch(/^M .+ L .+ L .+$/)
  })

  it('niceCeil:1/2/5 进位', () => {
    expect(niceCeil(0)).toBe(0)
    expect(niceCeil(1)).toBe(1)
    expect(niceCeil(3)).toBe(5)
    expect(niceCeil(12_000)).toBe(20_000)
    expect(niceCeil(58_432)).toBe(100_000)
    expect(niceCeil(Number.NaN)).toBe(0)
  })

  it('hover 列换算:指针吸附最近时点列,边缘 clamp', () => {
    // 30 列、宽 640、padX 8:列距 = (640-16)/29 ≈ 21.52
    expect(columnIndexAt(8, 30, 640, 8)).toBe(0) // 最左列
    expect(columnIndexAt(632, 30, 640, 8)).toBe(29) // 最右列
    expect(columnIndexAt(-50, 30, 640, 8)).toBe(0) // 越界 clamp
    expect(columnIndexAt(9999, 30, 640, 8)).toBe(29)
    expect(columnIndexAt(8 + 21.52 * 10, 30, 640, 8)).toBe(10) // 中间列就近吸附
    expect(columnIndexAt(8 + 21.52 * 10 + 9, 30, 640, 8)).toBe(10) // 半距内仍归该列
    expect(columnIndexAt(8 + 21.52 * 10 + 11, 30, 640, 8)).toBe(11) // 过半距归下一列
  })

  it('hover 列换算:单列/空序列/非法输入不出 NaN', () => {
    expect(columnIndexAt(123, 1, 640, 8)).toBe(0)
    expect(columnIndexAt(123, 0, 640, 8)).toBe(0)
    expect(columnIndexAt(Number.NaN, 30, 640, 8)).toBe(0)
    // 列中心与 linePoints 同源:首尾列贴 padX / width-padX,单列居中
    expect(columnCenterX(0, 30, 640, 8)).toBe(8)
    expect(columnCenterX(29, 30, 640, 8)).toBe(632)
    expect(columnCenterX(0, 1, 640, 8)).toBe(320)
  })
})

describe('usage-geometry(模型 donut 与颜色)', () => {
  const items = [
    { provider: 'kimi-coding', model: 'kimi-for-coding', totalTokens: 500 },
    { provider: 'zai-coding-cn', model: 'glm-4.7', totalTokens: 300 },
    { provider: 'deepseek', model: 'deepseek-v4-flash', totalTokens: 200 },
  ]

  it('分段:≤5 个模型不合并,比例守恒', () => {
    const segs = donutSegments(items)
    expect(segs.length).toBe(3)
    expect(segs.map((s) => s.colorIndex)).toEqual([0, 1, 2])
    expect(segs.reduce((a, s) => a + s.ratio, 0)).toBeCloseTo(1, 10)
  })

  it('分段:>5 个模型合并「其他」,明细不受影响', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      provider: 'p',
      model: `m${i}`,
      totalTokens: (7 - i) * 100,
    }))
    const segs = donutSegments(many)
    expect(segs.length).toBe(6)
    expect(segs[5]).toMatchObject({ key: '__other__', label: '其他', colorIndex: null })
    expect(segs[5]!.totalTokens).toBe(200 + 100) // m5+m6
    expect(segs.reduce((a, s) => a + s.totalTokens, 0)).toBe(
      many.reduce((a, m) => a + m.totalTokens, 0),
    )
  })

  it('分段:总量为 0 时比例为 0,不出 NaN', () => {
    const segs = donutSegments([{ provider: 'p', model: 'm', totalTokens: 0 }])
    expect(segs[0]!.ratio).toBe(0)
  })

  it('弧长:整圆 dasharray 覆盖周长,起笔于 12 点方向', () => {
    const full = donutArc(1, 0, 64)
    const c = 2 * Math.PI * 64
    const round2 = (n: number) => Math.round(n * 100) / 100
    expect(full.dasharray).toBe(`${round2(c)} 0`)
    expect(full.dashoffset).toBe(round2(c / 4))

    const half = donutArc(0.5, 0.25, 64)
    const [len] = half.dasharray.split(' ').map(Number)
    expect(len).toBeCloseTo(c / 2, 1)
  })

  it('颜色映射:按降序取五行色,>5 循环,三处同源', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      provider: 'p',
      model: `m${i}`,
      totalTokens: 100 - i,
    }))
    const map = modelColorMap(many)
    expect(map.get(modelKey('p', 'm0'))).toBe(0)
    expect(map.get(modelKey('p', 'm4'))).toBe(4)
    expect(map.get(modelKey('p', 'm5'))).toBe(0) // 第 6 个循环回第一色
  })

  it('颜色映射:同名模型不同 provider 各自独立', () => {
    const map = modelColorMap([
      { provider: 'a', model: 'same', totalTokens: 2 },
      { provider: 'b', model: 'same', totalTokens: 1 },
    ])
    expect(map.get('a/same')).toBe(0)
    expect(map.get('b/same')).toBe(1)
  })
})
