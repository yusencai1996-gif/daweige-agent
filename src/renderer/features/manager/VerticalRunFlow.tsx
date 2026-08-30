import { useMemo } from 'react'
import type { AgentRunGraph, AgentRunSummary } from '../../../shared/domain'
import { layoutGraph, upstreamLabelsOf } from './agent-run-graph-layout'
import { elapsedMsOf, formatElapsedMs } from './collab-panel-model'
import { shortStatusText, statusInfo } from './DelegationCard'
import { formatTokens } from '../usage/usage-format'

/**
 * 纵向流程图(A-28,PLAN §6.3):协作链面板的流程主体。
 *
 * - 拓扑层自上而下堆叠(layoutGraph.columns 与横向旧图同源):同层=并行节点,
 *   收进一个「并行」分组框;层与层之间用连接行表达边——
 *   handoff 边「来自:某角色(交棒)」、dependency 边「依赖:某角色」(文字与旧图窄屏同款);
 * - 窄面板不画 SVG 测量线:左侧一条 CSS 时间轴轨道 + 节点状态点,连线语义由连接行承担,
 *   收起/展开动画期间无需重测坐标(PLAN §6.5 的测量窗口直接不存在);
 * - 每节点一行:状态点 + 角色名 + 状态短语 + 已运行时长(共享时钟 now 由 Host 传入);
 * - onSelectRun 给了才可点(详情态左栏点节点切 tab);当前选中节点朱砂描边;
 * - 纯展示推导,无内部状态;reduced-motion 不影响(本组件无动画)。
 */

interface VerticalRunFlowProps {
  readonly graph: AgentRunGraph
  /** 共享时钟(PLAN §6.4-4:单个 timer,页面隐藏暂停);只用于已运行时长显示。 */
  readonly now: number
  readonly selectedRunId?: string | null
  readonly onSelectRun?: ((runId: string) => void) | undefined
}

export function VerticalRunFlow({ graph, now, selectedRunId, onSelectRun }: VerticalRunFlowProps) {
  const layout = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph])

  return (
    <ol className="collab-flow" aria-label="协作链流程">
      {layout.columns.map((layer, layerIndex) => {
        const parallel = layer.length > 1
        return (
          <li
            key={`layer-${layerIndex}`}
            className={`collab-flow-layer${parallel ? ' is-parallel' : ''}`}
          >
            {parallel && <span className="collab-flow-parallel-tag muted">并行</span>}
            {layer.map((node) => (
              <FlowEntry
                key={node.runId}
                graph={graph}
                node={node}
                layout={layout}
                now={now}
                selected={selectedRunId === node.runId}
                onSelectRun={onSelectRun}
              />
            ))}
          </li>
        )
      })}
    </ol>
  )
}

interface FlowEntryProps {
  readonly graph: AgentRunGraph
  readonly node: AgentRunSummary
  readonly layout: ReturnType<typeof layoutGraph>
  readonly now: number
  readonly selected: boolean
  readonly onSelectRun?: ((runId: string) => void) | undefined
}
/** 单个节点:上游交接连接行(有边才出)+ 节点行本体。 */
function FlowEntry({ graph, node, layout, now, selected, onSelectRun }: FlowEntryProps) {
  const info = statusInfo(node)
  const upstreams = upstreamLabelsOf(graph, layout, node.runId)
  const elapsed = elapsedMsOf(node, now)
  const label = `协作链节点:${node.targetRoleName},${shortStatusText(node)}${
    elapsed !== null ? `,已运行 ${formatElapsedMs(elapsed)}` : ''
  }${selected ? ',正在查看' : ''}`

  const rowBody = (
    <>
      <span className={`delegation-dot ${info.tone}`} aria-hidden="true" />
      <span className="collab-flow-name" title={node.taskBrief}>
        {node.targetRoleName}
      </span>
      <span className="collab-flow-state muted">{shortStatusText(node)}</span>
      {node.followupCount > 0 && (
        <span className="collab-flow-followup muted">追加 {node.followupCount} 次</span>
      )}
      {elapsed !== null && (
        <span className="collab-flow-elapsed muted">{formatElapsedMs(elapsed)}</span>
      )}
    </>
  )

  return (
    <div className="collab-flow-entry">
      {upstreams.map((text) => (
        <span
          key={text}
          className={`collab-flow-upstream${text.includes('(交棒)') ? ' is-handoff' : ''}`}
        >
          {text}
        </span>
      ))}
      {onSelectRun === undefined ? (
        <div className={`collab-flow-node${selected ? ' is-current' : ''}`} aria-label={label}>
          {rowBody}
        </div>
      ) : (
        <button
          type="button"
          className={`collab-flow-node${selected ? ' is-current' : ''}`}
          aria-label={label}
          aria-current={selected ? 'step' : undefined}
          title={`查看 ${node.targetRoleName} 的干活过程`}
          onClick={() => onSelectRun(node.runId)}
        >
          {rowBody}
        </button>
      )}
    </div>
  )
}

/**
 * 汇总数字行(PLAN §6.3 CollaborationAggregate):小面板顶部与详情态流程栏顶部共用。
 * graph.aggregate 由 composePanelGraph 从活体节点本地算出(口径同主进程),直接读不再推导。
 * rejected 单列成「未派出 N」(与节点状态文案对齐;主进程 DTO 未带该字段时退回 0)。
 * 每项指标各自 nowrap(数字+单位/数字+量词不拆行,「万」字不孤行),折行只发生在项间。
 */
export function CollabAggregate({ graph }: { readonly graph: AgentRunGraph }) {
  const { active, completed, failed, interrupted, totalTokens } = graph.aggregate
  const rejected = graph.aggregate.rejected ?? 0
  return (
    <span className="collab-aggregate muted">
      <span className="u-nowrap">{graph.nodes.length} 节点</span>
      {' · '}
      <span className="u-nowrap">进行中 {active}</span>
      {' · '}
      <span className="u-nowrap">完成 {completed}</span>
      {failed > 0 && (
        <>
          {' · '}
          <span className="u-nowrap">失败 {failed}</span>
        </>
      )}
      {rejected > 0 && (
        <>
          {' · '}
          <span className="u-nowrap">未派出 {rejected}</span>
        </>
      )}
      {interrupted > 0 && (
        <>
          {' · '}
          <span className="u-nowrap">中断 {interrupted}</span>
        </>
      )}
      {' · '}
      <span className="u-nowrap">总 token {formatTokens(totalTokens)}</span>
    </span>
  )
}
