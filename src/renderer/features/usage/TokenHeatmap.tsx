import { useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { UsageDashboard } from '../../../shared/domain'
import { formatTokensFull } from './usage-format'
import { aggregateWeeks, cumulativeDays, intensityLevel } from './usage-geometry'
import { useHoverDelay } from './use-hover-delay'

type HeatmapMode = 'daily' | 'weekly' | 'cumulative'

const MODE_LABELS: readonly { readonly key: HeatmapMode; readonly label: string }[] = [
  { key: 'daily', label: '每日' },
  { key: 'weekly', label: '每周' },
  { key: 'cumulative', label: '累计' },
]

interface TokenHeatmapProps {
  readonly activity: UsageDashboard['activity']
}

/**
 * Token 活动热力图(CSS Grid,365 格;每日/每周/累计三档全部由本地日桶派生)。
 * 每日=365 日桶原样;每周=连续 7 日一桶(≤53);累计=年内逐日运行累计。
 * hover(A-09):事件委托读 data-tip,单实例悬浮卡(每日=当日值/每周=起止+合计/累计=累计值),
 * 70ms 延迟显示防划过闪烁,离开网格即隐。
 */
export function TokenHeatmap({ activity }: TokenHeatmapProps) {
  const [mode, setMode] = useState<HeatmapMode>('daily')

  /* hover 悬浮卡(A-09):单实例复用,格子只带 data-tip 文本 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tip = useHoverDelay()
  const [hover, setHover] = useState<{
    readonly text: string
    readonly left: number
    readonly top: number
    readonly flipX: boolean
    readonly below: boolean
  } | null>(null)

  const cells = useMemo(() => {
    if (mode === 'weekly') {
      return aggregateWeeks(activity.days).map((w) => ({
        key: w.fromDate,
        tooltip: `${w.fromDate} ~ ${w.toDate} · 共 ${formatTokensFull(w.totalTokens)} tokens`,
        value: w.totalTokens,
        today: false,
      }))
    }
    const source = mode === 'cumulative' ? cumulativeDays(activity.days) : activity.days
    return source.map((d) => ({
      key: d.date,
      tooltip:
        mode === 'cumulative'
          ? `${d.date} · 累计 ${formatTokensFull(d.totalTokens)} tokens`
          : `${d.date} · ${formatTokensFull(d.totalTokens)} tokens`,
      value: d.totalTokens,
      today: d.date === activity.toDate,
    }))
  }, [activity, mode])

  const max = useMemo(() => cells.reduce((acc, c) => Math.max(acc, c.value), 0), [cells])

  /* 事件委托:over 冒泡到容器,读格子的 data-tip;离开容器即隐藏 */
  const onGridOver = (e: MouseEvent<HTMLDivElement>) => {
    const cont = scrollRef.current
    if (!cont) return
    const cell = (e.target as HTMLElement).closest('.usage-heat-cell')
    if (!cell || !cont.contains(cell)) return
    const text = (cell as HTMLElement).dataset.tip
    if (!text) return
    const cRect = cont.getBoundingClientRect()
    const visX = e.clientX - cRect.left
    const visY = e.clientY - cRect.top
    setHover({
      text,
      left: visX + cont.scrollLeft,
      top: visY + cont.scrollTop,
      flipX: visX > cRect.width - 210,
      below: visY < 64,
    })
    tip.arm()
  }

  return (
    <section className="usage-section" aria-label="Token 活动热力图">
      <div className="usage-section-head">
        <h3 className="usage-section-title">活动</h3>
        <div className="usage-switch" role="group" aria-label="热力图粒度">
          {MODE_LABELS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={mode === m.key ? 'usage-switch-btn active' : 'usage-switch-btn'}
              aria-pressed={mode === m.key}
              onClick={() => {
                setMode(m.key)
                setHover(null)
                tip.hide()
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="usage-heatmap-scroll"
        ref={scrollRef}
        onMouseOver={onGridOver}
        onMouseLeave={tip.hide}
      >
        <div
          className={
            mode === 'weekly' ? 'usage-heatmap usage-heatmap-weekly' : 'usage-heatmap'
          }
          role="list"
          aria-label={`最近一年 Token 活动(${activity.fromDate} ~ ${activity.toDate})`}
        >
          {cells.map((cell) => (
            <div
              key={cell.key}
              role="listitem"
              className={`usage-heat-cell level-${intensityLevel(cell.value, max)}${
                cell.today ? ' today' : ''
              }`}
              data-tip={cell.tooltip}
              aria-label={cell.tooltip}
            />
          ))}
        </div>
        {/* hover 悬浮卡(单实例;默认隐藏,悬停才出现) */}
        {tip.visible && hover !== null && (
          <div
            className="usage-tooltip"
            role="tooltip"
            style={{
              left: hover.left,
              top: hover.top,
              transform: `translate(${hover.flipX ? 'calc(-100% - 10px)' : '10px'}, ${
                hover.below ? '12px' : 'calc(-100% - 8px)'
              })`,
            }}
          >
            {hover.text}
          </div>
        )}
      </div>
      <div className="usage-heatmap-legend">
        <span className="usage-legend-text">少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`usage-heat-cell level-${level}`} aria-hidden="true" />
        ))}
        <span className="usage-legend-text">多</span>
        <span className="usage-legend-text usage-legend-range">
          {activity.fromDate} ~ {activity.toDate}
        </span>
      </div>
    </section>
  )
}
