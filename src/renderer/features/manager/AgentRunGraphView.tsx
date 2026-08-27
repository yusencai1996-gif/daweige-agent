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

interface GraphLayout {
  /** 拓扑序全部节点(同层按 createdAt 谱序);窄屏单列直接用它。 */
  readonly order: readonly AgentRunSummary[]
  /** 按拓扑深度分列(仅宽屏 DAG 用);列内保持 createdAt 谱序。 */
  readonly columns: readonly (readonly AgentRunSummary[])[]
  /** 每个 run 收到的边(to → edge 列表);窄屏用它出「来自/依赖」文字行。 */
  readonly incoming: ReadonlyMap<string, readonly AgentRunGraphEdge[]>
}

/**
 * 纯前端布局推导:Kahn 拓扑 + 最长路定深。图由服务端保证无环;
 * 万一遇到环(契约外脏数据),剩余节点 depth=0 兜底排在队尾,不崩不丢节点。
 */
function layoutGraph(
  nodes: readonly AgentRunSummary[],
  edges: readonly AgentRunGraphEdge[],
): GraphLayout {
  const knownIds = new Set(nodes.map((n) => n.runId))
  const validEdges = edges.filter(
    (e) => knownIds.has(e.fromRunId) && knownIds.has(e.toRunId) && e.fromRunId !== e.toRunId,
  )
  const byCreatedAt = [...nodes].sort((a, b) => a.createdAt - b.createdAt)
  const createdAtOf = new Map(byCreatedAt.map((n) => [n.runId, n.createdAt]))

  const indegree = new Map<string, number>(byCreatedAt.map((n) => [n.runId, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of validEdges) {
    indegree.set(edge.toRunId, (indegree.get(edge.toRunId) ?? 0) + 1)
    outgoing.set(edge.fromRunId, [...(outgoing.get(edge.fromRunId) ?? []), edge.toRunId])
  }
  // Kahn:同轮内按 createdAt 谱序处理,得到稳定的拓扑序列
  let frontier = byCreatedAt.filter((n) => (indegree.get(n.runId) ?? 0) === 0)
  const topoIds: string[] = []
  while (frontier.length > 0) {
    const nextIds: string[] = []
    for (const node of frontier) {
      topoIds.push(node.runId)
      for (const to of outgoing.get(node.runId) ?? []) {
        const left = (indegree.get(to) ?? 1) - 1
        indegree.set(to, left)
        if (left === 0) nextIds.push(to)
      }
    }
    frontier = nextIds
      .map((id) => ({ id, at: createdAtOf.get(id) ?? 0 }))
      .sort((a, b) => a.at - b.at)
      .map(({ id }) => nodes.find((n) => n.runId === id)!)
      .filter((node): node is AgentRunSummary => node !== undefined)
  }
  // 环兜底:拓扑没走到的节点接在队尾(正常数据到不了这里)
  for (const node of byCreatedAt) if (!topoIds.includes(node.runId)) topoIds.push(node.runId)

  // 最长路定深:depth[to] = max(depth[from] + 1)
  const depth = new Map<string, number>(nodes.map((n) => [n.runId, 0]))
  for (const id of topoIds) {
    for (const to of outgoing.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1))
    }
  }

  const columnCount = Math.max(1, ...nodes.map((n) => (depth.get(n.runId) ?? 0) + 1))
  const columns: AgentRunSummary[][] = Array.from({ length: columnCount }, () => [])
  for (const node of byCreatedAt) columns[depth.get(node.runId) ?? 0]?.push(node)

  const incoming = new Map<string, AgentRunGraphEdge[]>()
  for (const edge of validEdges) {
    incoming.set(edge.toRunId, [...(incoming.get(edge.toRunId) ?? []), edge])
  }
  const order = topoIds.map((id) => nodes.find((n) => n.runId === id)).filter(
    (node): node is AgentRunSummary => node !== undefined,
  )

  return { order, columns, incoming }
}

interface WirePath {
  readonly key: string
  readonly kind: AgentRunGraphEdge['kind']
  readonly d: string
  readonly labelX: number
  readonly labelY: number
}

/** 进入某节点的上游角色名(窄屏文字行用)。 */
function upstreamNamesOf(
  graph: AgentRunGraph,
  layout: GraphLayout,
  runId: string,
): string[] {
  return (layout.incoming.get(runId) ?? []).map((edge) => {
    const name = graph.nodes.find((n) => n.runId === edge.fromRunId)?.targetRoleName
    return edge.kind === 'handoff'
      ? `来自:${name ?? '上游'}(交棒)`
      : `依赖:${name ?? '上游'}`
  })
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
