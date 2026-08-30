/**
 * 协作链常驻面板(A-28,PLAN §6.2/§6.4/§6.5)的纯函数模型层。
 *
 * 全部不读浏览器 API、不依赖 React,node 环境直接单测:
 * - 当前链选择五规则里的确定性部分(规则 1/2 + pin 覆盖回退);
 * - tab 选中回退(节点增删后落到哪条);
 * - 节点已运行时长计算与格式化;
 * - 面板展示用 graph 合成(推送活体节点 + 缓存边 + 本地汇总);
 * - FLIP 动画的变换计算与 reduced-motion 决策。
 */
import type {
  AgentRunDetail,
  AgentRunGraph,
  AgentRunGraphEdge,
  AgentRunStatus,
  AgentRunSummary,
} from '../../../shared/domain'

/* ============ 面板数据/动作接口(controller 产出,Host 与三个子组件消费) ============ */

/** 面板数据:graph 节点=推送活体,边=图谱缓存;由 use-app-controller 计算好推下来。 */
export interface CollabPanelData {
  readonly graph: AgentRunGraph | null
  readonly graphLoading: boolean
  /** 小窗态(用户手动收起,或全终态空闲时的默认)。 */
  readonly minimized: boolean
  /** 用户手动点开小窗(线框图:小窗态展开图标);全终态空闲链也据此回到面板态。 */
  readonly manualExpanded: boolean
  /** 详情态(右侧详情页展开)。 */
  readonly detailOpen: boolean
  /** 当前 tab 的 run(已做存在性回退);详情态与流程栏高亮共用。 */
  readonly selectedRunId: string | null
  readonly selectedDetail: AgentRunDetail | undefined
  readonly selectedDetailLoading: boolean
  /** 是否显式 pin(消息流派活卡点进来的);仅作展示态记录,暂无 UI 差异。 */
  readonly pinned: boolean
}

export interface CollabPanelActions {
  /** 小窗 → 面板。 */
  readonly expand: () => void
  /** 面板 → 小窗。 */
  readonly minimize: () => void
  /** 面板 → 详情;runId 给了则同时选中对应 tab(流程节点点击)。 */
  readonly openDetail: (runId?: string) => void
  /** 详情 → 面板/小窗。 */
  readonly closeDetail: () => void
  /** 详情态内切 tab / 点流程节点。 */
  readonly selectRun: (runId: string) => void
}

/** Host 裁决「有链」后保证 graph 非空的窄化形态;三个子组件的 props 用它。 */
export type CollabPanelDataReady = CollabPanelData & { readonly graph: AgentRunGraph }

/** 终态=不再有后续动作(与 DelegationCard.isTerminalStatus 同口径,纯函数层自带一份防循环依赖)。 */
const TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  'completed',
  'failed',
  'rejected',
  'interrupted',
]

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** 进行中口径(与主进程 aggregate.active 一致:占着链路等结果的都算)。 */
const ACTIVE_STATUSES: readonly AgentRunStatus[] = [
  'awaiting-approval',
  'queued',
  'running',
  'waiting',
]

export function isActiveRunStatus(status: AgentRunStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

/**
 * 当前协作链选择(PLAN §6.2 规则 1/2/3 的确定性部分):
 * 1. pin 的 graph 还在当前 run 列表里 → 直接用(规则 3 显式 pin 优先);
 * 2. 有非终态 graph → 选「最近节点 updatedAt」最新的一条;
 * 3. 全部终态 → 选最近更新的一条。
 * 规则 4(新链 push 未 pin 才自动切)由「未 pin 时每次重算」天然满足;规则 5(切会话清 pin)在 controller。
 * 无 run → null(面板整体不渲染)。
 */
export function resolvePanelGraphId(
  runs: readonly AgentRunSummary[],
  pinnedGraphId: string | null,
): string | null {
  if (runs.length === 0) return null
  if (pinnedGraphId !== null && runs.some((r) => r.graphId === pinnedGraphId)) {
    return pinnedGraphId
  }
  /** 每条 graph:最新节点 updatedAt + 是否有非终态节点。 */
  interface GraphStat {
    latestAt: number
    hasActive: boolean
  }
  const graphs = new Map<string, GraphStat>()
  for (const run of runs) {
    const entry = graphs.get(run.graphId) ?? { latestAt: 0, hasActive: false }
    entry.latestAt = Math.max(entry.latestAt, run.updatedAt)
    if (!isTerminalRunStatus(run.status)) entry.hasActive = true
    graphs.set(run.graphId, entry)
  }
  /** 同 latestAt 时保先入者(Map 迭代序=首见序),结果稳定。 */
  const latestOf = (candidates: [string, GraphStat][]): string | null => {
    let best: string | null = null
    let bestAt = -1
    for (const [graphId, stat] of candidates) {
      if (best === null || stat.latestAt > bestAt) {
        best = graphId
        bestAt = stat.latestAt
      }
    }
    return best
  }
  const all = [...graphs.entries()]
  const active = all.filter(([, stat]) => stat.hasActive)
  return latestOf(active.length > 0 ? active : all)
}

/**
 * tab 选中回退(PLAN §6.6「tab 选择与删除/新增节点回退」):
 * 选中 run 仍在节点里 → 保持;否则回退到最近更新的节点(运行中的新进展最相关);
 * 节点为空 → null(详情态随之收敛)。
 */
export function resolveSelectedRunId(
  nodes: readonly AgentRunSummary[],
  selectedRunId: string | null,
): string | null {
  if (nodes.length === 0) return null
  if (selectedRunId !== null && nodes.some((n) => n.runId === selectedRunId)) return selectedRunId
  let best: AgentRunSummary = nodes[0]!
  for (const node of nodes) if (node.updatedAt > best.updatedAt) best = node
  return best.runId
}

/**
 * 节点已运行时长(PLAN §6.1:前端本地时钟算,不需每秒 push):
 * - 未启动(awaiting/queued,startedAt 为 null)→ null,不显示计时;
 * - 非终态 → now - startedAt(共享 timer 驱动,逐秒走);
 * - 终态 → completedAt - startedAt(主进程终态迁移必写 completed_at;
 *   契约外缺失时退回 updatedAt,不显示负数)。
 */
export function elapsedMsOf(run: AgentRunSummary, now: number): number | null {
  if (run.startedAt === null) return null
  const end = isTerminalRunStatus(run.status) ? (run.completedAt ?? run.updatedAt) : now
  return Math.max(0, end - run.startedAt)
}

/** 时长短语:<1 分钟「N 秒」;<1 小时「M:SS」;再长「H:MM:SS」。面板节点行内用,求紧凑。 */
export function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}:${String(seconds).padStart(2, '0')}`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 面板汇总数字(与主进程 agent-run-query-service aggregate 同口径,本地从活体节点算)。
 *  一处刻意差异(0.5.0 视觉验收):rejected(未派出)不并入 failed——节点状态文案是「未派出」,
 *  汇总再叫「失败」就对不上;取消类单列,展示时写成「未派出 N」。 */
export interface CollabAggregate {
  readonly total: number
  readonly active: number
  readonly completed: number
  readonly failed: number
  /** 未派出(rejected):用户没点头的取消类,不并入「失败」。 */
  readonly rejected: number
  readonly interrupted: number
  readonly totalTokens: number
}

export function computeCollabAggregate(nodes: readonly AgentRunSummary[]): CollabAggregate {
  return {
    total: nodes.length,
    active: nodes.filter((n) => isActiveRunStatus(n.status)).length,
    completed: nodes.filter((n) => n.status === 'completed').length,
    failed: nodes.filter((n) => n.status === 'failed').length,
    rejected: nodes.filter((n) => n.status === 'rejected').length,
    interrupted: nodes.filter((n) => n.status === 'interrupted').length,
    totalTokens: nodes.reduce((sum, n) => sum + n.usage.totalTokens, 0),
  }
}

/** 依赖边可从 run 摘要的 dependsOnRunIds 推导;handoff 边只有 getGraph 知道(未取回时的过渡形态)。 */
export function deriveDependencyEdges(
  nodes: readonly AgentRunSummary[],
): readonly AgentRunGraphEdge[] {
  const knownIds = new Set(nodes.map((n) => n.runId))
  return nodes.flatMap((node) =>
    node.dependsOnRunIds
      .filter((from) => knownIds.has(from) && from !== node.runId)
      .map((from) => ({ fromRunId: from, toRunId: node.runId, kind: 'dependency' as const })),
  )
}

/**
 * 面板展示用 graph 合成(PLAN §6.4):
 * 节点永远取 run 列表里的活体(agent_run_updated 原位实时),边取缓存图谱
 * (含 handoff),图谱未取回时先用依赖边顶上——状态不落在旧快照上,交棒标识随后补齐。
 */
export function composePanelGraph(
  graphId: string,
  managerSessionId: string,
  liveNodes: readonly AgentRunSummary[],
  cached: AgentRunGraph | undefined,
): AgentRunGraph {
  const nodes = [...liveNodes].sort((a, b) => a.createdAt - b.createdAt)
  return {
    graphId,
    managerSessionId,
    nodes,
    edges: cached?.edges ?? deriveDependencyEdges(nodes),
    aggregate: computeCollabAggregate(nodes),
  }
}

/** 小窗态摘要行:节点名按拓扑序用「→」串起 + 节点数。调用方传 layout.order(拓扑序)。 */
export function chainSummaryLine(orderedNodes: readonly AgentRunSummary[]): string {
  const names = orderedNodes.map((n) => n.targetRoleName).join(' → ')
  return `${names} · ${orderedNodes.length} 节点`
}

/* ============ FLIP 动画纯计算(PLAN §6.5) ============ */

/** 一块可测量矩形(getBoundingClientRect 的子集,纯数据好单测)。 */
export interface PanelRect {
  readonly top: number
  readonly right: number
  readonly width: number
  readonly height: number
}

/**
 * FLIP 逆变换:让「已在新位置的元素」先视觉贴回旧矩形,再动画回 identity。
 * 外壳右上锚定 → transform-origin 固定 top right;只动 transform,不碰 width/height
 * (连续 width 动画会让 MessageList 每帧重排)。
 * 尺寸为 0(首帧/隐藏)时给 1 兜底,不出 Infinity。
 */
export function computeFlipTransform(from: PanelRect, to: PanelRect): string {
  const scaleX = from.width / Math.max(1, to.width)
  const scaleY = from.height / Math.max(1, to.height)
  // 右上对齐:右边距差 + 顶边距差
  const dx = from.right - to.right
  const dy = from.top - to.top
  return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
}

/** reduced-motion 决策(PLAN §6.5:reduce 直接切状态,不起动画)。注入布尔,组件侧读 matchMedia。 */
export function panelTransitionKind(reducedMotion: boolean): 'flip' | 'instant' {
  return reducedMotion ? 'instant' : 'flip'
}

/**
 * 面板三态裁决(Host 每次渲染调用):
 * - 无链 → null(整体不渲染;普通角色会话/零 run 的 manager 会话都走这里);
 * - detailOpen → 详情态(用户点「查看详情」/派活卡 pin 进来);
 * - 手动收起的 → 小窗态;
 * - 用户手动点开过小窗(manualExpanded)→ 面板态,即使链已全终态
 *   (线框图:小窗态展开图标必须点得开,否则空闲链的摘要行成了死路);
 * - 有非终态节点 → 面板态(有活跃 run 自动展开);
 * - 全终态且没手动展开 → 小窗态(空闲,上次链摘要一行)。
 */
export type CollabPanelView = 'mini' | 'panel' | 'detail'

export function resolvePanelView(input: {
  readonly hasGraph: boolean
  readonly detailOpen: boolean
  readonly minimized: boolean
  readonly manualExpanded: boolean
  readonly activeCount: number
}): CollabPanelView | null {
  if (!input.hasGraph) return null
  if (input.detailOpen) return 'detail'
  if (input.minimized) return 'mini'
  if (input.manualExpanded) return 'panel'
  return input.activeCount > 0 ? 'panel' : 'mini'
}
