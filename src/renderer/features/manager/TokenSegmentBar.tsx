/**
 * A-25(0.5.0):派活用量分项横条图(一根横条四段:输入/输出/缓存读/缓存写)。
 *
 * - 两处共用:DelegationCard 展开区 + AgentRunProcessPane 顶部(A-28 已收编进协作链面板);
 *   组件不绑定任何页面生命周期,只收 usage 四项;
 * - 比例真实:flex-grow 按比例分配,不设破坏比例的最小段宽(极小段 hover 不到时,
 *   完整数值仍由整根横条的 aria-label/焦点 tooltip 兜底);
 * - 色板零变动:四段只复用 --usage-model-1..4,不新增任何色值;
 * - 无障碍:role="img" + 完整 aria-label(四项完整整数+合计),可 Tab 聚焦,
 *   focus 时出 tooltip 全文;hover 单段出该段完整整数(原生 title);
 * - 窄窗:自身 width:100%/min-width:0,tooltip 绝对定位不占布局,不制造横向滚动。
 */

import { useMemo } from 'react'
import type { TokenSegmentKey, TokenSegmentUsageInput } from './token-segments'
import { buildTokenSegments, tokenSegmentTip, tokenSegmentsAriaLabel } from './token-segments'

export interface TokenSegmentBarProps {
  /** 只收四项分项;totalTokens 故意不在输入面里(分母=四项之和,见 token-segments.ts)。 */
  readonly usage: TokenSegmentUsageInput
}

/** 段色映射固定:输入=松蓝 / 输出=听雾绿 / 缓存读=朱砂 / 缓存写=檀褐(沿用使用统计五行色板)。 */
const SEGMENT_CLASS: Record<TokenSegmentKey, string> = {
  input: 'token-segment-input',
  output: 'token-segment-output',
  cacheRead: 'token-segment-cache-read',
  cacheWrite: 'token-segment-cache-write',
}

export function TokenSegmentBar({ usage }: TokenSegmentBarProps) {
  const data = useMemo(
    () =>
      buildTokenSegments({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
    [usage],
  )
  const label = tokenSegmentsAriaLabel(data)
  // 0 值段不占位(宽度恒 0 画不出);其数值仍保留在 aria-label/焦点 tooltip 里
  const visible = data.segments.filter((s) => s.ratio > 0)

  return (
    <div className="token-segment-bar" role="img" tabIndex={0} aria-label={label} data-tip={label}>
      <div className={`token-segment-track${data.empty ? ' is-empty' : ''}`} aria-hidden="true">
        {visible.map((segment) => (
          <div
            key={segment.key}
            className={`token-segment ${SEGMENT_CLASS[segment.key]}`}
            style={{ flexGrow: segment.ratio, flexBasis: 0 }}
            title={tokenSegmentTip(segment)}
          />
        ))}
      </div>
    </div>
  )
}
