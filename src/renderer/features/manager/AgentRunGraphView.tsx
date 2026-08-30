import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentRunGraph,
  AgentRunGraphEdge,
  AgentRunSummary,
} from '../../../shared/domain'
import { formatTokens } from '../usage/usage-format'
import {
  interruptSourceLabel,
  queueReasonText,
  shortStatusText,
  statusInfo,
} from './DelegationCard'
// A-28(0.5.0 第三批):拓扑排序/入边推导提取为共用纯函数,横向旧图与纵向新图(VerticalRunFlow)同源
import { layoutGraph, upstreamLabelsOf, type GraphLayout } from './agent-run-graph-layout'

/**
 * 协作链族谱视图(0.4.0 D 批 UI):详情页顶部的整条链可视化。
 *
 * - 宽屏(视口 ≥1000px)左到右 DAG:节点按拓扑深度分层成列(flex 布局,
 *   不用 canvas、不给节点写死坐标),边用一层绝对定位 SVG 笔触线连接两端锚点;
 *   handoff 边中点标「交棒」小字,dependency 边不标。
 * - 窄屏(<1000px)拓扑序单列:每节点一张卡,边转「来自:某角色(交棒)/依赖:某角色」文字行,不画线。
 * - 图状态完全由 DTO(graph.nodes/edges/aggregate)推导,本地不存第二份;
 *   节点点击非当前 run → 复用 openAgentRunDetail 打开那条 run 的详情页。
 * - 无障碍:节点 aria-label 带角色名+状态;窄屏单列的上下游关系用文字表达;
 *   节点出现不做任何动画(reduced-motion 天然满足)。
 */

/** 视口断点:≥1000px 用分层 DAG,<1000px 用单列。 */
const WIDE_BREAKPOINT = '(min-width: 1000px)'

function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_BREAKPOINT).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_BREAKPOINT)
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

interface WirePath {
  readonly key: string
  readonly kind: AgentRunGraphEdge['kind']
  readonly d: string
  readonly labelX: number
  readonly labelY: number
}

/** 进入某节点的上游角色名(窄屏文字行用);0.5.0 起与纵向面板共用同一份推导。 */
function upstreamNamesOf(
  graph: AgentRunGraph,
  layout: GraphLayout,
  runId: string,
): string[] {
  return upstreamLabelsOf(graph, layout, runId)
}

/** 单个族谱节点卡:当前 run 为静态高亮,其余渲染成可点按钮跳对应详情页。 */
function GraphNode({
  run,
  current,
  onOpen,
  setNodeRef,
}: {
  readonly run: AgentRunSummary
  readonly current: boolean
  readonly onOpen: (runId: string) => void
  readonly setNodeRef: (runId: string, el: HTMLElement | null) => void
}) {
  const info = statusInfo(run)
  const usage = run.usage
  const hasUsage = usage.rounds > 0 || usage.totalTokens > 0
  const queueHint = run.status === 'queued' ? queueReasonText(run.queueReason) : null
  const interruptHint =
    run.status === 'interrupted' ? interruptSourceLabel(run.interruptSource) : null
  const label = `协作链节点:${run.targetRoleName},${shortStatusText(run)}${
    queueHint !== null ? `,${queueHint}` : ''
  }${current ? ',正在查看这张' : ''}`
  const metaBits = [
    ...(hasUsage ? [`轮次 ${usage.rounds} · token ${formatTokens(usage.totalTokens)}`] : []),
    ...(run.followupCount > 0 ? [`追加 ${run.followupCount} 次`] : []),
  ]
  const body = (
    <>
      <div className="run-node-head">
        <span className={`delegation-dot ${info.tone}`} aria-hidden="true" />
        <span className="run-node-name">{run.targetRoleName}</span>
        <span className="run-node-state">{shortStatusText(run)}</span>
      </div>
      <p className="run-node-task" title={run.taskBrief}>
        {run.taskBrief}
      </p>
      {(metaBits.length > 0 || queueHint !== null || interruptHint !== null) && (
        <div className="run-node-foot">
          {metaBits.length > 0 && (
            <span className="run-node-meta muted">{metaBits.join(' · ')}</span>
          )}
          {queueHint !== null && <span className="run-node-hint">{queueHint}</span>}
          {interruptHint !== null && (
            <span className="run-node-hint">打断来源:{interruptHint}</span>
          )}
        </div>
      )}
    </>
  )

  if (current) {
    return (
      <div
        ref={(el) => setNodeRef(run.runId, el)}
        className="run-node is-current"
        aria-label={label}
        aria-current="step"
      >
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      ref={(el) => setNodeRef(run.runId, el)}
      className="run-node"
      aria-label={label}
      title={`查看 ${run.targetRoleName} 的干活过程`}
      onClick={() => onOpen(run.runId)}
    >
      {body}
    </button>
  )
}

interface AgentRunGraphViewProps {
  readonly graph: AgentRunGraph
  /** 当前详情页打开的那条 run:高亮为朱砂聚焦,且不可再点进自己。 */
  readonly currentRunId: string
  readonly onOpenRun: (runId: string) => void
}

export function AgentRunGraphView({ graph, currentRunId, onOpenRun }: AgentRunGraphViewProps) {
  const wide = useWideViewport()
  const boardRef = useRef<HTMLDivElement | null>(null)
  const nodeRefs = useRef(new Map<string, HTMLElement>())
  const [wires, setWires] = useState<readonly WirePath[]>([])
  const layout = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph])

  const setNodeRef = (runId: string, el: HTMLElement | null) => {
    if (el === null) nodeRefs.current.delete(runId)
    else nodeRefs.current.set(runId, el)
  }

  /**
   * 宽屏边的锚点测量:节点位置完全交给 flex 流式布局,SVG 只负责在两个 DOM 锚点间连线——
   * 节点坐标不承载任何语义。容器尺寸变化(换档/字重排)时 ResizeObserver 重测。
   */
  useLayoutEffect(() => {
    if (!wide) return
    const board = boardRef.current
    if (board === null) return
    const measure = () => {
      const box = board.getBoundingClientRect()
      const next: WirePath[] = []
      for (const edge of graph.edges) {
        const fromEl = nodeRefs.current.get(edge.fromRunId)
        const toEl = nodeRefs.current.get(edge.toRunId)
        if (fromEl === undefined || toEl === undefined) continue
        const a = fromEl.getBoundingClientRect()
        const b = toEl.getBoundingClientRect()
        const x1 = a.right - box.left
        const y1 = a.top + a.height / 2 - box.top
        const x2 = b.left - box.left
        const y2 = b.top + b.height / 2 - box.top
        const dx = Math.max(24, Math.min(56, Math.abs(x2 - x1) / 2))
        next.push({
          key: `${edge.fromRunId}->${edge.toRunId}:${edge.kind}`,
          kind: edge.kind,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          // 三次贝塞尔中点(t=0.5):横控点相抵,midX=(x1+x2)/2、midY=(y1+y2)/2
          labelX: (x1 + x2) / 2,
          labelY: (y1 + y2) / 2 - 5,
        })
      }
      setWires(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(board)
    return () => observer.disconnect()
  }, [wide, graph])

  const { active, completed, failed, interrupted, totalTokens } = graph.aggregate

  return (
    <section className="run-graph" aria-label={graphLabel(graph)}>
      <div className="run-graph-head">
        <span className="run-graph-title">协作链</span>
        <span className="muted run-graph-stats">
          {graph.nodes.length} 节点 · 进行中 {active} · 已完成 {completed} · 失败 {failed} · 中断{' '}
          {interrupted} · 总 token {formatTokens(totalTokens)}
        </span>
      </div>

      {wide ? (
        <div className="run-graph-scroll">
          <div className="run-graph-board" ref={boardRef}>
            <svg className="run-graph-wires" aria-hidden="true">
              {wires.map((wire) => (
                <g key={wire.key}>
                  <path
                    d={wire.d}
                    className={`run-graph-wire${wire.kind === 'handoff' ? ' handoff' : ''}`}
                  />
                  {wire.kind === 'handoff' && (
                    <text
                      className="run-graph-label"
                      x={wire.labelX}
                      y={wire.labelY}
                      textAnchor="middle"
                    >
                      交棒
                    </text>
                  )}
                </g>
              ))}
            </svg>
            <div className="run-graph-columns">
              {layout.columns.map((column, index) => (
                <div className="run-graph-col" key={`col-${index}`}>
                  {column.map((node) => (
                    <GraphNode
                      key={node.runId}
                      run={node}
                      current={node.runId === currentRunId}
                      onOpen={onOpenRun}
                      setNodeRef={setNodeRef}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ol className="run-graph-list">
          {layout.order.map((node) => {
            const upstreams = upstreamNamesOf(graph, layout, node.runId)
            return (
              <li key={node.runId} className="run-graph-entry">
                <GraphNode
                  run={node}
                  current={node.runId === currentRunId}
                  onOpen={onOpenRun}
                  setNodeRef={setNodeRef}
                />
                {upstreams.map((text) => (
                  <span key={text} className="run-item-upstream">
                    {text}
                  </span>
                ))}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/** 区块级读法(屏幕阅读器一行听完整条链概况)。 */
function graphLabel(graph: AgentRunGraph): string {
  const { active, completed, failed, interrupted } = graph.aggregate
  return `协作链共 ${graph.nodes.length} 个节点:${active} 进行中,${completed} 已完成,${failed} 失败,${interrupted} 中断`
}
