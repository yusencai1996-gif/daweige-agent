import { useMemo } from 'react'
import type { AgentRunDetail, AgentRunGraph, AgentRunSummary } from '../../../shared/domain'
import { MessageList } from '../chat/MessageList'
import { formatTokens, formatTokensFull } from '../usage/usage-format'
import { InterruptControl, statusInfo, type DelegationCardActions } from './DelegationCard'
import { AgentRunGraphView } from './AgentRunGraphView'
import type { ConversationTimelineItem } from './conversation-timeline'

/**
 * internal 只读详情整页(0.3.0 批 2b,PLAN §10.3)。
 *
 * - 顶部:「返回小柊」+ 目标角色名 + 任务简报 + 状态 + 用量(轮次/总 token);
 * - 协作链(0.4.0 D):graph 已取回且多节点时,头部下挂「协作链」族谱区块;
 *   单节点链不渲染(0.3 行为不变);非终态 run 附打断入口;
 * - 正文:复用 MessageList 渲染 childSession 的消息/思考块/工具行,不重写消息组件;
 * - 不渲染 Composer:internal 会话只读,不能发消息/中止/改名/归档/删除;
 * - 数据刷新由 controller 负责(agent_run_updated → 重拉 agentRun:getDetail)。
 */

interface AgentRunDetailViewProps {
  /** 当前 run(来自 manager 会话 run 列表,状态随 agent_run_updated 实时)。 */
  readonly run: AgentRunSummary
  /** 已取回的详情;undefined = 还在取。 */
  readonly detail: AgentRunDetail | undefined
  readonly detailLoading: boolean
  /** 当前 run 所属协作链整图(controller 懒加载缓存;单节点链恒为 undefined)。 */
  readonly graph: AgentRunGraph | undefined
  readonly graphLoading: boolean
  /** MessageList 的时间线里没有 run 项,派活卡动作用不到,原样透传满足签名。 */
  readonly delegation: DelegationCardActions
  /** 族谱里点其他节点 → 打开那条 run 的详情页(复用 openAgentRunDetail)。 */
  readonly onOpenRun: (runId: string) => void
  readonly onBack: () => void
}

export function AgentRunDetailView({
  run,
  detail,
  detailLoading,
  graph,
  graphLoading,
  delegation,
  onOpenRun,
  onBack,
}: AgentRunDetailViewProps) {
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
    <div className="run-detail-pane">
      <div className="run-detail-header">
        <div className="run-detail-header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            ‹ 返回小柊
          </button>
          <div className="run-detail-heading">
            <h2 className="run-detail-title">{run.targetRoleName}的干活过程</h2>
            <div className="run-detail-sub muted" title={run.taskBrief}>
              {run.taskBrief}
            </div>
          </div>
        </div>
        <div className="run-detail-meta">
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
          <InterruptControl
            run={run}
            busy={delegation.interruptBusyFor(run.runId)}
            onInterrupt={delegation.onInterrupt}
          />
        </div>
      </div>

      {/* 协作链族谱(0.4.0 D):懒加载中的弱提示;单节点链两分支都不渲染,0.3 行为不变 */}
      {graphLoading && graph === undefined && (
        <div className="run-detail-sync muted" role="status">
          <span className="delegation-dot active" aria-hidden="true" />
          正在取这条协作链的图谱…
        </div>
      )}
      {graph !== undefined && graph.nodes.length > 1 && (
        <AgentRunGraphView graph={graph} currentRunId={run.runId} onOpenRun={onOpenRun} />
      )}

      {run.status === 'running' && (
        // 顺手项(0.3.0 整改):干活进行中给低频呼吸点,盖住防抖同步间隙,不显得卡死
        <div className="run-detail-sync muted" role="status">
          <span className="delegation-dot active" aria-hidden="true" />
          正在同步干活过程…
        </div>
      )}

      {detail === undefined ? (
        <div className="run-detail-state muted">
          {detailLoading ? '正在翻过程记录…' : '过程没取到,返回后从卡片再试一次。'}
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
