import { useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { UsageDashboard } from '../../../shared/domain'
import { formatTokens, formatTokensFull } from './usage-format'
import {
  columnCenterX,
  columnIndexAt,
  linePath,
  linePoints,
  modelKey,
  niceCeil,
  tail,
} from './usage-geometry'
import { useHoverDelay } from './use-hover-delay'

const WIDTH = 640
const HEIGHT = 220
const PAD_X = 8
const PAD_Y = 14

type TrendRange = 7 | 30

interface TokenTrendChartProps {
  readonly trend: UsageDashboard['trend']
  /** (provider/model) → 五行色下标;与 donut/明细同源(按 models.items 降序取色)。 */
  readonly colorMap: ReadonlyMap<string, number>
}

/**
 * 每日趋势折线(手绘 SVG):近 7 / 30 日切换(7 日取 30 日序列尾 7);
 * 所有系列共享同一条 y 轴刻度(niceCeil 上限,与网格线同源),量级可比;
 * 全零系列(窗口内无用量)不绘制;图例可点击显隐模型(aria-pressed),
 * 同名模型以 provider 消歧,颜色与 donut/明细一致。
 * hover(A-09):吸附最近时点列,单实例悬浮卡显示该日各可见模型完整整数,
 * 跟随指针、边缘翻转,70ms 延迟显示防快速划过闪烁,离开即隐。
 */
export function TokenTrendChart({ trend, colorMap }: TokenTrendChartProps) {
  const [range, setRange] = useState<TrendRange>(30)
  const [hidden, setHidden] = useState<readonly string[]>([])

  /* hover 悬浮卡(A-09):吸附到最近时点列;位置跟随指针,边缘翻转 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tip = useHoverDelay()
  const [hover, setHover] = useState<{
    readonly index: number
    readonly left: number
    readonly top: number
    readonly flipX: boolean
    readonly below: boolean
  } | null>(null)

  const dates = useMemo(() => tail(trend.dates, range), [trend.dates, range])
  /* 先裁剪到当前窗口再过滤:全零系列(窗口内无用量)不参与绘制与图例——
     7 日窗口下"8~30 天前有量、近 7 天无量"的模型不应画成贴底平线 */
  const series = useMemo(
    () =>
      trend.series
        .map((s) => ({
          key: modelKey(s.provider, s.model),
          label: s.model,
          provider: s.provider,
          colorIndex: colorMap.get(modelKey(s.provider, s.model)) ?? 0,
          values: tail(s.values, range),
        }))
        .filter((s) => s.values.some((v) => v > 0)),
    [trend.series, colorMap, range],
  )
  /* 同名模型(不同 provider)图例消歧:重名时追加 provider */
  const displayLabels = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of series) counts.set(s.label, (counts.get(s.label) ?? 0) + 1)
    return new Map(
      series.map((s) => [
        s.key,
        (counts.get(s.label) ?? 0) > 1 ? `${s.label} · ${s.provider}` : s.label,
      ]),
    )
  }, [series])
  const visible = series.filter((s) => !hidden.includes(s.key))
  const max = niceCeil(visible.reduce((acc, s) => Math.max(acc, ...s.values), 0))

  const toggle = (key: string) => {
    setHidden((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
  }

  const gridLines = max > 0 ? [0.5, 1].map((r) => ({ ratio: r, value: max * r })) : []

  /* 指针在 svg 上移动:换算最近时点列并更新悬浮卡位置(容器坐标,含滚动量) */
  const onSvgMove = (e: MouseEvent<SVGSVGElement>) => {
    const cont = scrollRef.current
    if (!cont || dates.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const vx = ((e.clientX - rect.left) / rect.width) * WIDTH
    const index = columnIndexAt(vx, dates.length, WIDTH, PAD_X)
    const cRect = cont.getBoundingClientRect()
    const visX = e.clientX - cRect.left
    const visY = e.clientY - cRect.top
    setHover({
      index,
      left: visX + cont.scrollLeft,
      top: visY + cont.scrollTop,
      flipX: visX > cRect.width - 190,
      below: visY < 96,
    })
    tip.arm()
  }

  const hoverIndex = hover ? Math.min(hover.index, dates.length - 1) : null

  return (
    <section className="usage-section" aria-label="每日 Token 趋势">
      <div className="usage-section-head">
        <h3 className="usage-section-title">趋势</h3>
        <div className="usage-switch" role="group" aria-label="趋势范围">
          {([7, 30] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? 'usage-switch-btn active' : 'usage-switch-btn'}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r)
                setHover(null)
              }}
            >
              近 {r} 日
            </button>
          ))}
        </div>
      </div>

      {series.length === 0 ? (
        <div className="usage-chart-empty">
          {trend.series.length === 0
            ? '还没有模型用量记录。'
            : `近 ${range} 日还没有用量足迹。`}
        </div>
      ) : (
        <>
          <div className="usage-trend-scroll" ref={scrollRef} onMouseLeave={tip.hide}>
            <svg
              className="usage-trend-svg"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={`${dates[0] ?? ''} ~ ${dates[dates.length - 1] ?? ''} 各模型 Token 趋势`}
              onMouseMove={onSvgMove}
            >
              {/* 横向网格线(细 --line)+ y 轴刻度 */}
              {gridLines.map((g) => {
                const y = PAD_Y + (HEIGHT - PAD_Y * 2) * (1 - g.ratio)
                return (
                  <g key={g.ratio}>
                    <line
                      x1={PAD_X}
                      y1={y}
                      x2={WIDTH - PAD_X}
                      y2={y}
                      className="usage-trend-grid"
                    />
                    <text x={PAD_X + 2} y={y - 3} className="usage-trend-tick">
                      {formatTokens(g.value)}
                    </text>
                  </g>
                )
              })}
              <line
                x1={PAD_X}
                y1={HEIGHT - PAD_Y}
                x2={WIDTH - PAD_X}
                y2={HEIGHT - PAD_Y}
                className="usage-trend-grid"
              />
              {/* hover 吸附列参考线 */}
              {tip.visible && hoverIndex !== null && (
                <line
                  x1={columnCenterX(hoverIndex, dates.length, WIDTH, PAD_X)}
                  y1={PAD_Y}
                  x2={columnCenterX(hoverIndex, dates.length, WIDTH, PAD_X)}
                  y2={HEIGHT - PAD_Y}
                  className="usage-trend-guide"
                />
              )}
              {visible.map((s) => {
                const points = linePoints(s.values, WIDTH, HEIGHT, PAD_X, PAD_Y, max)
                /* 单点序列 path 不可见(M 命令零长度),画实心圆点兜底(fill 类,非 stroke) */
                if (points.length === 1) {
                  const p = points[0]!
                  return (
                    <circle
                      key={s.key}
                      cx={p.x}
                      cy={p.y}
                      r={3}
                      className={`usage-trend-dot usage-model-fill-${s.colorIndex + 1}`}
                    />
                  )
                }
                return (
                  <path
                    key={s.key}
                    d={linePath(points)}
                    className={`usage-trend-line usage-model-${s.colorIndex + 1}`}
                  />
                )
              })}
              {/* x 轴首尾日期 */}
              <text x={PAD_X} y={HEIGHT - 2} className="usage-trend-tick">
                {dates[0] ?? ''}
              </text>
              <text x={WIDTH - PAD_X} y={HEIGHT - 2} textAnchor="end" className="usage-trend-tick">
                {dates[dates.length - 1] ?? ''}
              </text>
            </svg>
            {/* hover 悬浮卡(单实例;默认隐藏,悬停才出现;完整整数) */}
            {tip.visible && hover !== null && hoverIndex !== null && (
              <div
                className="usage-tooltip"
                role="tooltip"
                style={{
                  left: hover.left,
                  top: hover.top,
                  transform: `translate(${
                    hover.flipX ? 'calc(-100% - 10px)' : '12px'
                  }, ${hover.below ? '12px' : 'calc(-100% - 10px)'})`,
                }}
              >
                <div className="usage-tooltip-date">{dates[hoverIndex] ?? ''}</div>
                {visible.map((s) => (
                  <div key={s.key} className="usage-tooltip-row">
                    <span
                      className={`usage-legend-dot usage-model-bg-${s.colorIndex + 1}`}
                      aria-hidden="true"
                    />
                    <span className="usage-tooltip-name">
                      {displayLabels.get(s.key) ?? s.label}
                    </span>
                    <span className="usage-tooltip-value">
                      {formatTokensFull(s.values[hoverIndex] ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="usage-trend-legend" role="group" aria-label="模型显隐">
            {series.map((s) => {
              const off = hidden.includes(s.key)
              return (
                <button
                  key={s.key}
                  type="button"
                  className={off ? 'usage-legend-btn off' : 'usage-legend-btn'}
                  aria-pressed={!off}
                  title={s.key}
                  onClick={() => toggle(s.key)}
                >
                  <span
                    className={`usage-legend-dot usage-model-bg-${s.colorIndex + 1}`}
                    aria-hidden="true"
                  />
                  {displayLabels.get(s.key) ?? s.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
