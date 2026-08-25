/**
 * 使用统计几何/聚合派生(纯函数,无依赖,可单测)。
 * 所有筛选都是从 dashboard 快照本地派生,不发新请求(契约冻结口径)。
 */

export interface DayBucket {
  readonly date: string
  readonly totalTokens: number
}

/* ============ 热力图 ============ */

/** 强度档位:0=零值(极浅墨痕);非零按相对峰值分四档(<=25/50/75/100%)。 */
export function intensityLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0
  const r = value / max
  if (r <= 0.25) return 1
  if (r <= 0.5) return 2
  if (r <= 0.75) return 3
  return 4
}

export interface WeekBucket {
  readonly fromDate: string
  readonly toDate: string
  readonly totalTokens: number
}

/** 日桶聚合为周桶:从首日连续每 7 天一桶,365 日 → 最多 53 桶。 */
export function aggregateWeeks(days: readonly DayBucket[]): WeekBucket[] {
  const weeks: WeekBucket[] = []
  for (let i = 0; i < days.length; i += 7) {
    const slice = days.slice(i, i + 7)
    let total = 0
    for (const d of slice) total += d.totalTokens
    weeks.push({
      fromDate: slice[0]?.date ?? '',
      toDate: slice[slice.length - 1]?.date ?? '',
      totalTokens: total,
    })
  }
  return weeks
}

/** 年内逐日运行累计(升序累加),返回与日桶等长的数组。 */
export function cumulativeDays(days: readonly DayBucket[]): DayBucket[] {
  let running = 0
  return days.map((d) => {
    running += d.totalTokens
    return { date: d.date, totalTokens: running }
  })
}

/* ============ 趋势折线 ============ */

/** 取尾部 n 项(近 7 日 = 30 日序列尾 7)。 */
export function tail<T>(items: readonly T[], n: number): T[] {
  return items.slice(Math.max(0, items.length - n))
}

export interface LinePoint {
  readonly x: number
  readonly y: number
}

/**
 * 折线坐标:y 轴向下为 SVG 坐标系。
 * 空序列 → [];单点 → 水平居中;全零 → 贴底直线;max<=0 时不产生 NaN/Infinity。
 * maxOverride:多系列共享刻度(网格线同源);缺省/非法时回落为自身峰值。
 */
export function linePoints(
  values: readonly number[],
  width: number,
  height: number,
  padX = 8,
  padY = 12,
  maxOverride?: number,
): LinePoint[] {
  if (values.length === 0) return []
  const ownMax = Math.max(0, ...values)
  const max =
    maxOverride !== undefined && Number.isFinite(maxOverride) && maxOverride > 0
      ? maxOverride
      : ownMax
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  if (values.length === 1) {
    return [{ x: padX + innerW / 2, y: yOf(values[0] ?? 0, max, padY, innerH) }]
  }
  const step = innerW / (values.length - 1)
  return values.map((v, i) => ({
    x: round2(padX + step * i),
    y: yOf(v, max, padY, innerH),
  }))
}

function yOf(v: number, max: number, padY: number, innerH: number): number {
  const ratio = max > 0 ? Math.max(0, v) / max : 0
  return round2(padY + innerH * (1 - ratio))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 折线 path("M x y L x y …");空序列 → 空串。 */
export function linePath(points: readonly LinePoint[]): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  const head = `M ${first!.x} ${first!.y}`
  return rest.reduce((acc, p) => `${acc} L ${p.x} ${p.y}`, head)
}

/** y 轴上限取"好看整数":1/2/5 × 10^n 进位(0 → 0,用于刻度标签)。 */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const mag = 10 ** Math.floor(Math.log10(value))
  const norm = value / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}

/* ============ 趋势 hover 列换算(A-09) ============ */

/** 指针 viewBox x → 最近时点列下标;count<=1 恒 0;clamp 到 [0, count-1]。 */
export function columnIndexAt(x: number, count: number, width: number, padX: number): number {
  if (count <= 1) return 0
  if (!Number.isFinite(x)) return 0
  const step = (width - padX * 2) / (count - 1)
  const idx = Math.round((x - padX) / step)
  return Math.min(count - 1, Math.max(0, idx))
}

/** 第 index 列的中心 viewBox x(与 linePoints 的 x 计算同源);count<=1 时水平居中。 */
export function columnCenterX(index: number, count: number, width: number, padX: number): number {
  const inner = width - padX * 2
  if (count <= 1) return padX + inner / 2
  return padX + (inner / (count - 1)) * index
}

/* ============ 模型 donut ============ */

export interface ModelItem {
  readonly provider: string
  readonly model: string
  readonly totalTokens: number
}

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * 稳定颜色映射:按 models.items 顺序(后端已降序)从五行色板取色;
 * 超过 5 个循环复用(i % 5)。折线/donut/明细三处共用此映射保证同色。
 */
export function modelColorMap(items: readonly ModelItem[]): Map<string, number> {
  const map = new Map<string, number>()
  items.forEach((item, i) => {
    map.set(modelKey(item.provider, item.model), i % 5)
  })
  return map
}

export interface DonutSegment {
  /** 模型键;"其他"段为 '__other__'。 */
  readonly key: string
  readonly label: string
  readonly totalTokens: number
  /** 占传入 items 总量的比例(0..1);总量为 0 时各段为 0。 */
  readonly ratio: number
  /** 五行色下标 0..4;"其他"段为 null(用 --line 灰)。 */
  readonly colorIndex: number | null
}

/** donut 分段:前 top 名 + 其余合并为「其他」。 */
export function donutSegments(items: readonly ModelItem[], top = 5): DonutSegment[] {
  const total = items.reduce((acc, it) => acc + it.totalTokens, 0)
  const head = items.slice(0, top)
  const rest = items.slice(top)
  const segments: DonutSegment[] = head.map((it, i) => ({
    key: modelKey(it.provider, it.model),
    label: it.model,
    totalTokens: it.totalTokens,
    ratio: total > 0 ? it.totalTokens / total : 0,
    colorIndex: i % 5,
  }))
  if (rest.length > 0) {
    const restTokens = rest.reduce((acc, it) => acc + it.totalTokens, 0)
    segments.push({
      key: '__other__',
      label: '其他',
      totalTokens: restTokens,
      ratio: total > 0 ? restTokens / total : 0,
      colorIndex: null,
    })
  }
  return segments
}

/**
 * donut 分段描边:基于 stroke-dasharray/offset 的圆环分段。
 * 12 点方向起笔(dashoffset 以 C/4 为基准逆时针累加)。
 */
export function donutArc(
  ratio: number,
  startRatio: number,
  radius: number,
): { readonly dasharray: string; readonly dashoffset: number; readonly circumference: number } {
  const circumference = 2 * Math.PI * radius
  const len = Math.max(0, Math.min(1, ratio)) * circumference
  const dashoffset = circumference / 4 - Math.max(0, startRatio) * circumference
  return {
    dasharray: `${round2(len)} ${round2(circumference - len)}`,
    dashoffset: round2(dashoffset),
    circumference: round2(circumference),
  }
}
