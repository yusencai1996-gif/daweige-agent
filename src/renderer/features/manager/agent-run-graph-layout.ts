/**
 * 协作链图布局纯函数(0.5.0 第三批 A-28,PLAN §6.3 重构 1)。
 *
 * 从 AgentRunGraphView 提取的拓扑推导,两处共用:
 * - 横向旧图(AgentRunGraphView 宽屏 DAG):columns 按拓扑深度分列;
 * - 纵向新图(VerticalRunFlow 面板):同一套 layers 纵向堆叠,同层=并行节点。
 *
 * 全部为纯函数,不读浏览器 API,node 环境可直接单测。
 */
import type {
  AgentRunGraph,
  AgentRunGraphEdge,
  AgentRunSummary,
} from '../../../shared/domain'

export interface GraphLayout {
  /** 拓扑序全部节点(同层按 createdAt 谱序);单列/纵向流直接用它。 */
  readonly order: readonly AgentRunSummary[]
  /** 按拓扑深度分层;层内保持 createdAt 谱序(宽屏=列,纵向面板=层)。 */
  readonly columns: readonly (readonly AgentRunSummary[])[]
  /** 每个 run 收到的边(to → edge 列表);交接标识文字行用它推导。 */
  readonly incoming: ReadonlyMap<string, readonly AgentRunGraphEdge[]>
}

/**
 * 纯前端布局推导:Kahn 拓扑 + 最长路定深。图由服务端保证无环;
 * 万一遇到环(契约外脏数据),剩余节点按 createdAt 兜底排在队尾,不崩不丢节点。
 */
export function layoutGraph(
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
  const order = topoIds
    .map((id) => nodes.find((n) => n.runId === id))
    .filter((node): node is AgentRunSummary => node !== undefined)

  return { order, columns, incoming }
}

/**
 * 进入某节点的上游交接标识文案(纵向流连接行/窄屏文字行共用):
 * handoff 边 → 「来自:某角色(交棒)」;dependency 边 → 「依赖:某角色」。
 * 同一上游多条边逐条出一行,语义无损。
 */
export function upstreamLabelsOf(
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
