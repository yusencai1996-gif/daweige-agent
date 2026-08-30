import type { AgentRunDetail, AgentRunGraph, AgentRunSummary } from '../../../shared/domain'
import type { DelegationCardActions } from './DelegationCard'
import { AgentRunGraphView } from './AgentRunGraphView'
import { AgentRunProcessPane } from './AgentRunProcessPane'

/**
 * @deprecated A-28(0.5.0 第三批,PLAN §6.3 重构 3):internal 只读详情整页已收编进
 * 协作链常驻面板的详情态(CollaborationPanelExpanded),ViewMode='agent-run-detail'
 * 路由与 App.tsx 分支已删,本组件不再被任何路由挂载。
 * 文件暂作兼容壳保留:页面骨架原样,消息过程主体由 AgentRunProcessPane 承担
 * (逻辑不复制);确认面板全量回归后可整体删除本文件。
 */

interface AgentRunDetailViewProps {
  /** 当前 run(来自 manager 会话 run 列表,状态随 agent_run_updated 实时)。 */
  readonly run: AgentRunSummary
  /** 已取回的详情;undefined = 还在取。 */
  readonly detail: AgentRunDetail | undefined
  readonly detailLoading: boolean
  /** 当前 run 所属协作链整图(单节点链恒为 undefined)。 */
  readonly graph: AgentRunGraph | undefined
  readonly graphLoading: boolean
  /** MessageList 的时间线里没有 run 项,派活卡动作用不到,原样透传满足签名。 */
  readonly delegation: DelegationCardActions
  /** 族谱里点其他节点 → 打开那条 run(收编后此入口已无路由消费者)。 */
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
      </div>

      {/* 协作链族谱(0.4.0 D):单节点链不渲染;横向旧图组件与纵向面板共用拓扑纯函数 */}
      {graphLoading && graph === undefined && (
        <div className="run-detail-sync muted" role="status">
          <span className="delegation-dot active" aria-hidden="true" />
          正在取这条协作链的图谱…
        </div>
      )}
      {graph !== undefined && graph.nodes.length > 1 && (
        <AgentRunGraphView graph={graph} currentRunId={run.runId} onOpenRun={onOpenRun} />
      )}

      {/* 消息过程主体(A-28 提取):状态行/用量横条/呼吸提示/MessageList 全部在 ProcessPane */}
      <AgentRunProcessPane
        run={run}
        detail={detail}
        detailLoading={detailLoading}
        delegation={delegation}
      />
    </div>
  )
}
