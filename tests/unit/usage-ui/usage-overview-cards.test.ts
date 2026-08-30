// A-26:总览第三卡——「最长活跃时长」新文案 + 口径说明 tooltip + 可见值完整不裁切。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageOverviewCards } from '../../../src/renderer/features/usage/UsageOverviewCards'
import type { UsageDashboard } from '../../../src/shared/domain'

const overview: UsageDashboard['overview'] = {
  totalTokens: 8_432_168,
  peakDailyTokens: 58_432,
  longestActiveSessionDurationMs: 9_360_000, // 2小时36分
  currentStreakDays: 6,
  longestStreakDays: 21,
}

describe('UsageOverviewCards(A-26 第三卡)', () => {
  it('label 为「最长活跃时长」,title 为口径说明,可见值完整', () => {
    const html = renderToStaticMarkup(createElement(UsageOverviewCards, { overview }))
    expect(html).toContain('最长活跃时长')
    expect(html).not.toContain('最长会话<')
    expect(visibleText(html)).toContain('2小时36分')
    expect(html).toContain('同一会话内,相邻请求不超过 30 分钟的间隔累计')
  })

  it('120 小时级长值完整渲染(不截断,截断由 CSS 保证不出现)', () => {
    const html = renderToStaticMarkup(
      createElement(UsageOverviewCards, {
        overview: { ...overview, longestActiveSessionDurationMs: 120 * 3_600_000 + 35 * 60_000 },
      }),
    )
    expect(visibleText(html)).toContain('120小时35分')
  })
})

/** 卡片值按「数字+单位」组合包了 nowrap span(0.5.0 防孤行),断言看剥掉标签后的可见文本。 */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}
