import type { UsageDashboard } from '../../../shared/domain'
import { formatDurationMs, formatTokens, formatTokensFull, numberUnitSegments } from './usage-format'

interface UsageOverviewCardsProps {
  readonly overview: UsageDashboard['overview']
}

interface CardSpec {
  readonly label: string
  readonly value: string
  /** 完整数值(tooltip,不缩写)。 */
  readonly full: string
}

/** 总览五卡:累计 Token / 单日峰值 / 最长活跃时长 / 当前连续天数 / 最长连续天数。 */
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
      // A-26:真实活跃时长口径——可见值完整不裁切,title 只放口径说明(可见=可复制)
      label: '最长活跃时长',
      value: formatDurationMs(overview.longestActiveSessionDurationMs),
      full: '同一会话内,相邻请求不超过 30 分钟的间隔累计',
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
          {/* 数字+单位逐段 nowrap(「2小时36分」不拆成「2小时36」+「分」);
              组合之间仍允许折行——可见值完整不裁切(A-26 口径不变) */}
          <div className="usage-card-value">
            {numberUnitSegments(card.value).map((segment, index) => (
              <span key={index} className="u-nowrap">
                {segment}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
