import { useMemo, useState } from 'react'
import type { AgentRunDetail } from '../../../shared/domain'
import { layoutGraph } from './agent-run-graph-layout'
import { AgentRunTabs } from './AgentRunTabs'
import { AgentRunProcessPane } from './AgentRunProcessPane'
import { CollabAggregate, VerticalRunFlow } from './VerticalRunFlow'
import type { CollabPanelActions, CollabPanelDataReady } from './collab-panel-model'
import type { DelegationCardActions } from './DelegationCard'

/**
 * 协作链面板·详情态(A-28,PLAN §6.3):点「查看详情」后从右上角展开的侧边详情页。
 *
 * - 占 main-pane 右侧约 40%(宽屏),对话区被压住但不离开(覆盖层,不切页);
 * - 左栏=简要流程(CollaborationFlowPane:汇总 + VerticalRunFlow,点节点切 tab);
 * - 右栏=详情区(CollaborationDetailPane:顶部 AgentRunTabs 一个角色一个 tab,
 *   tab 内是该角色完整输出过程 AgentRunProcessPane);
 * - 720 窄窗:外壳覆盖 main-pane 可用宽度,左栏收成顶部可折叠抽屉(默认收起,
 *   点「流程」展开),tabs 与过程区保持可用不溢出;
 * - 「收起」回到面板/小窗态(由 Host 按数据态裁决)。
 */

interface CollaborationPanelExpandedProps {
  readonly data: CollabPanelDataReady
  readonly actions: CollabPanelActions
  readonly now: number
  /** 过程区的打断/派活动作合集(controller 稳定引用透传)。 */
  readonly delegation: DelegationCardActions
}

export function CollaborationPanelExpanded({
  data,
  actions,
  now,
  delegation,
}: CollaborationPanelExpandedProps) {
  const { graph, selectedRunId } = data
  /** 窄窗流程抽屉(仅 <1000px 可见可点;宽屏左栏常驻,此状态不影响)。 */
  const [flowDrawerOpen, setFlowDrawerOpen] = useState(false)

  // tab 顺序与纵向流同源(拓扑序);选中 run 的对象给过程区
  const orderedNodes = useMemo(
    () => layoutGraph(graph.nodes, graph.edges).order,
    [graph],
  )
  const selectedRun = orderedNodes.find((n) => n.runId === selectedRunId) ?? null
  const detail: AgentRunDetail | undefined = data.selectedDetail

  return (
    <section className="collab-detail" aria-label="协作链详情">
      <header className="collab-panel-head">
        <span className="collab-panel-title">协作链</span>
        <CollabAggregate graph={graph} />
        <button
          type="button"
          className="btn btn-ghost btn-sm collab-detail-close"
          onClick={actions.closeDetail}
        >
          收起
        </button>
      </header>

      {/* 窄窗流程抽屉开关(宽屏 CSS 隐藏);文案带节点数,一眼知规模 */}
      <button
        type="button"
        className="btn btn-ghost btn-sm collab-flow-drawer-toggle"
        aria-expanded={flowDrawerOpen}
        onClick={() => setFlowDrawerOpen((v) => !v)}
      >
        {flowDrawerOpen ? '收起流程' : `流程 · ${graph.nodes.length} 节点`}
      </button>

      <div className={`collab-detail-body${flowDrawerOpen ? ' flow-open' : ''}`}>
        <aside className="collab-flow-pane" aria-label="协作链流程">
          <VerticalRunFlow
            graph={graph}
            now={now}
            selectedRunId={selectedRunId}
            onSelectRun={actions.selectRun}
          />
        </aside>
        <div className="collab-detail-pane">
          <AgentRunTabs
            nodes={orderedNodes}
            selectedRunId={selectedRunId}
            onSelect={actions.selectRun}
          />
          {selectedRun === null ? (
            <div className="run-detail-state muted">这条链上还没有节点。</div>
          ) : (
            <AgentRunProcessPane
              run={selectedRun}
              detail={detail}
              detailLoading={data.selectedDetailLoading}
              delegation={delegation}
            />
          )}
        </div>
      </div>
    </section>
  )
}
