import { useMemo } from 'react'
import type { AgentRunDetail, AgentRunSummary } from '../../../shared/domain'
import { MessageList } from '../chat/MessageList'
import { formatTokens, formatTokensFull } from '../usage/usage-format'
import { InterruptControl, statusInfo, type DelegationCardActions } from './DelegationCard'
import { TokenSegmentBar } from './TokenSegmentBar'
import type { ConversationTimelineItem } from './conversation-timeline'

/**
 * 派活过程主体(A-28,PLAN §6.3 重构 2):从旧整页 AgentRunDetailView 提取,
 * 协作链面板详情态的 tab 内容 = 这里;消息渲染复用 MessageList,不复制逻辑。
 *
 * 内容:状态行(点+文案+轮次/总 token+打断入口)→ TokenSegmentBar(有用量时)
 * → 运行中呼吸提示 → 过程消息流/空态。头部标题与「返回」不再归这里管
 * (面板里角色切换由 AgentRunTabs 承担)。
 */

interface AgentRunProcessPaneProps {
  /** 当前 tab 的 run(活体摘要,状态随 agent_run_updated 实时)。 */
  readonly run: AgentRunSummary
  /** 已取回的详情;undefined = 还在取/没取到。 */
  readonly detail: AgentRunDetail | undefined
  readonly detailLoading: boolean
  /** MessageList 签名需要;面板 tab 内没有 run 卡,动作用不到,原样透传。 */
  readonly delegation: DelegationCardActions
}

export function AgentRunProcessPane({
  run,
  detail,
  detailLoading,
  delegation,
}: AgentRunProcessPaneProps) {
  const info = statusInfo(run)
  const { usage } = run
  const hasUsage = usage.rounds > 0 || usage.totalTokens > 0

  // child 消息 → 时间线条目(纯消息,无 run 卡);detail 未到/会话缺失时为空
  const items: readonly ConversationTimelineItem[] = useMemo(
    () =>
      (detail?.childSession?.messages ?? []).map((message) => ({
        kind: 'message' as const,
        message,
      })),
    [detail],
  )

  return (
    <div className="run-process-pane">
      <div className="run-process-meta">
        <span className={`delegation-dot ${info.tone}`} aria-hidden="true" />
        <span>{info.text}</span>
        {hasUsage && (
          <span
            className="muted"
            title={`输入 ${formatTokensFull(usage.inputTokens)} · 输出 ${formatTokensFull(usage.outputTokens)} · 缓存读 ${formatTokensFull(usage.cacheReadTokens)} · 缓存写 ${formatTokensFull(usage.cacheWriteTokens)} tokens`}
          >
            轮次 {usage.rounds} · 总 token {formatTokens(usage.totalTokens)}
          </span>
        )}
        {run.followupCount > 0 && <span className="muted">追加 {run.followupCount} 次</span>}
        <InterruptControl
          run={run}
          busy={delegation.interruptBusyFor(run.runId)}
          onInterrupt={delegation.onInterrupt}
        />
      </div>

      {/* 分项横条(A-25):与派活卡展开区同一组件;面板 tab 顶部同款(PLAN §3 统筹补注) */}
      {hasUsage && (
        <div className="run-process-usage-bar">
          <TokenSegmentBar usage={usage} />
        </div>
      )}

      {run.status === 'running' && (
        // 运行中给低频呼吸点,盖住防抖同步间隙,不显得卡死(沿用旧整页顺手项)
        <div className="run-detail-sync muted" role="status">
          <span className="delegation-dot active" aria-hidden="true" />
          正在同步干活过程…
        </div>
      )}

      {detail === undefined ? (
        <div className="run-detail-state muted">
          {detailLoading ? '正在翻过程记录…' : '过程没取到,换个 tab 再点回来试试。'}
        </div>
      ) : detail.childSession === null ? (
        <div className="run-detail-state muted">过程会话缺失,记录找不回来了。</div>
      ) : items.length === 0 ? (
        <div className="run-detail-state muted">过程会话里还没有留下消息。</div>
      ) : (
        <MessageList
          items={items}
          roleName={run.targetRoleName}
          streamingMessageId={null}
          onRetry={() => undefined}
          delegation={delegation}
        />
      )}
    </div>
  )
}
