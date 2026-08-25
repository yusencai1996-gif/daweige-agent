import type { UsageDashboard } from '../../../shared/domain'
import { formatDurationMs, formatTokens, formatTokensFull } from './usage-format'

interface UsageOverviewCardsProps {
  readonly overview: UsageDashboard['overview']
}

interface CardSpec {
  readonly label: string
  readonly value: string
  /** 完整数值(tooltip,不缩写)。 */
  readonly full: string
}

/** 总览五卡:累计 Token / 单日峰值 / 最长会话时长 / 当前连续天数 / 最长连续天数。 */
export function UsageOverviewCards({ overview }: UsageOverviewCardsProps) {
  const cards: readonly CardSpec[] = [
    {
      label: '累计 Token',
      value: formatTokens(overview.totalTokens),
      full: `${formatTokensFull(overview.totalTokens)} tokens`,
    },
    {
      label: '单日峰值',
      value: formatTokens(overview.peakDailyTokens),
      full: `${formatTokensFull(overview.peakDailyTokens)} tokens`,
    },
    {
      label: '最长会话',
      value: formatDurationMs(overview.longestSessionDurationMs),
      full: formatDurationMs(overview.longestSessionDurationMs),
    },
    {
      label: '当前连续',
      value: `${overview.currentStreakDays} 天`,
      full: `连续使用 ${overview.currentStreakDays} 天`,
    },
    {
      label: '最长连续',
      value: `${overview.longestStreakDays} 天`,
      full: `历史最长连续 ${overview.longestStreakDays} 天`,
    },
  ]
  return (
    <div className="usage-cards">
      {cards.map((card) => (
        <div key={card.label} className="usage-card" title={card.full}>
          <div className="usage-card-label">{card.label}</div>
          <div className="usage-card-value">{card.value}</div>
        </div>
      ))}
    </div>
  )
}
