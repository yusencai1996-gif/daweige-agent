import { useMemo } from 'react'
import type { UsageDashboard } from '../../../shared/domain'
import { formatPercent, formatTokens, formatTokensFull } from './usage-format'
import { donutArc, donutSegments, modelKey } from './usage-geometry'

const RADIUS = 64
const STROKE = 22
const SIZE = 168

interface ModelDonutChartProps {
  readonly models: UsageDashboard['models']
  /** (provider/model) → 五行色下标;与折线同源。 */
  readonly colorMap: ReadonlyMap<string, number>
}

/**
 * 模型用量环形图(SVG stroke-dasharray 分段)+ 明细列表。
 * donut 前 5 名 + 「其他」合并;明细列全部(文本冗余,信息不只在颜色里)。
 */
export function ModelDonutChart({ models, colorMap }: ModelDonutChartProps) {
  const segments = useMemo(() => donutSegments(models.items), [models.items])

  let acc = 0
  const arcs = segments.map((seg) => {
    const arc = donutArc(seg.ratio, acc, RADIUS)
    acc += seg.ratio
    return { seg, arc }
  })

  return (
    <section className="usage-section" aria-label="模型用量占比">
      <div className="usage-section-head">
        <h3 className="usage-section-title">模型用量</h3>
      </div>
      {models.items.length === 0 ? (
        <div className="usage-chart-empty">还没有模型用量记录。</div>
      ) : (
        <div className="usage-donut-row">
          <svg
            className="usage-donut"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label={`模型用量环形图,累计 ${formatTokensFull(models.totalTokens)} tokens`}
          >
            {/* 底环(细 --line) */}
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              className="usage-donut-track"
              strokeWidth={STROKE}
            />
            {arcs.map(({ seg, arc }) => (
              <circle
                key={seg.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                strokeDasharray={arc.dasharray}
                strokeDashoffset={arc.dashoffset}
                className={
                  seg.colorIndex === null
                    ? 'usage-donut-other'
                    : `usage-model-stroke-${seg.colorIndex + 1}`
                }
              >
                <title>{`${seg.label} · ${formatTokensFull(seg.totalTokens)} tokens (${formatPercent(seg.ratio)})`}</title>
              </circle>
            ))}
            <text x={SIZE / 2} y={SIZE / 2 - 6} textAnchor="middle" className="usage-donut-total">
              {formatTokens(models.totalTokens)}
            </text>
            <text x={SIZE / 2} y={SIZE / 2 + 14} textAnchor="middle" className="usage-donut-sub">
              累计 Token
            </text>
          </svg>

          <ul className="usage-model-list">
            {models.items.map((item) => {
              const key = modelKey(item.provider, item.model)
              const colorIndex = colorMap.get(key) ?? 0
              const ratio = models.totalTokens > 0 ? item.totalTokens / models.totalTokens : 0
              return (
                <li
                  key={key}
                  className={item.totalTokens > 0 ? 'usage-model-item' : 'usage-model-item zero'}
                >
                  <span
                    className={`usage-legend-dot usage-model-bg-${colorIndex + 1}`}
                    aria-hidden="true"
                  />
                  <span className="usage-model-name" title={`${item.model}(${item.provider})`}>
                    {item.model}
                  </span>
                  <span className="usage-model-provider">{item.provider}</span>
                  <span
                    className="usage-model-value"
                    title={`${formatTokensFull(item.totalTokens)} tokens`}
                  >
                    {formatTokens(item.totalTokens)}
                  </span>
                  <span className="usage-model-pct">{formatPercent(ratio)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
