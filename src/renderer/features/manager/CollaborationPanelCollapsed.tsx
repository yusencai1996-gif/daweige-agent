import { useMemo } from 'react'
import { layoutGraph } from './agent-run-graph-layout'
import { chainSummaryLine } from './collab-panel-model'
import { CollabAggregate, VerticalRunFlow } from './VerticalRunFlow'
import type { CollabPanelActions, CollabPanelDataReady } from './collab-panel-model'

/**
 * 协作链面板·收起侧(A-28,PLAN §6.3):小窗态与面板态两副形态。
 *
 * - 小窗态(minimized 或全部终态的空闲时):右上角紧凑小卡——
 *   标题「协作链」+ 上次链摘要一行(角色名拓扑序串联)+ 展开图标;整卡可点展开;
 * - 面板态(有活跃 run 自动出现,或小窗点展开):纵向流程图小面板——
 *   顶部汇总数字(CollabAggregate)+ VerticalRunFlow + 「查看详情」「收起」。
 * 「简要展示,但要美观」(用户原话):不做重装饰,信息一行就是一行。
 */

interface CollaborationPanelCollapsedProps {
  readonly data: CollabPanelDataReady
  readonly actions: CollabPanelActions
  /** 共享时钟(面板态节点时长显示);小窗态不显示时长,原样透传即可。 */
  readonly now: number
  /** true=小窗态(紧凑小卡);false=面板态(流程小面板)。 */
  readonly mini: boolean
}

export function CollaborationPanelCollapsed({
  data,
  actions,
  now,
  mini,
}: CollaborationPanelCollapsedProps) {
  const { graph } = data
  const summaryLine = useMemo(
    () => chainSummaryLine(layoutGraph(graph.nodes, graph.edges).order),
    [graph],
  )

  if (mini) {
    return (
      <button
        type="button"
        className="collab-mini"
        onClick={actions.expand}
        aria-label={`协作链:${summaryLine};点开看流程`}
        title="点开看协作链流程"
      >
        <span className="collab-mini-head">
          <span className="collab-panel-title">协作链</span>
          <span className="collab-mini-chevron" aria-hidden="true">
            ▸
          </span>
        </span>
        <span className="collab-mini-line muted">{summaryLine}</span>
      </button>
    )
  }

  return (
    <section className="collab-flowpanel" aria-label="协作链面板">
      <header className="collab-panel-head">
        <span className="collab-panel-title">协作链</span>
        <CollabAggregate graph={graph} />
      </header>
      <div className="collab-flowpanel-body">
        <VerticalRunFlow graph={graph} now={now} onSelectRun={(runId) => actions.openDetail(runId)} />
      </div>
      <footer className="collab-panel-foot">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => actions.openDetail()}
        >
          查看详情
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={actions.minimize}>
          收起
        </button>
      </footer>
    </section>
  )
}
