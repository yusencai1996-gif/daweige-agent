/**
 * A-28(0.5.0 第三批,PLAN §6.6):agent-run-graph-layout 纯函数单测。
 * 覆盖:串行拓扑序 / 并行同层 / handoff·dependency 边文案 / 环兜底不丢节点 / 非法边过滤。
 * 横向旧图(AgentRunGraphView)与纵向新图(VerticalRunFlow)共用这套推导,一处测两处稳。
 */
import { describe, expect, it } from 'vitest'
import type { AgentRunGraph, AgentRunSummary } from '../../../src/shared/domain'
import {
  layoutGraph,
  upstreamLabelsOf,
} from '../../../src/renderer/features/manager/agent-run-graph-layout'

let seq = 0
/** 最小 run 夹具:只关心布局相关字段,其余填固定值。 */
function makeRun(
  runId: string,
  overrides?: Partial<AgentRunSummary> & { readonly createdAt?: number },
): AgentRunSummary {
  seq += 1
  return {
    runId,
    managerSessionId: 'mgr-1',
    targetRoleId: `role-${runId}`,
    targetRoleName: overrides?.targetRoleName ?? `角色${runId}`,
    internalSessionId: null,
    parentRunId: null,
    status: 'completed',
    waitingReason: null,
    graphId: 'graph-1',
    dependsOnRunIds: [],
    queueReason: null,
    followupCount: 0,
    interruptSource: null,
    taskBrief: `任务 ${runId}`,
    allowedWorkspacePaths: [],
    usage: { rounds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    createdAt: overrides?.createdAt ?? seq * 1000,
    startedAt: null,
    completedAt: null,
    updatedAt: overrides?.createdAt ?? seq * 1000,
    ...overrides,
  }
}

function graphOf(
  nodes: readonly AgentRunSummary[],
  edges: AgentRunGraph['edges'],
): AgentRunGraph {
  return {
    graphId: 'graph-1',
    managerSessionId: 'mgr-1',
    nodes,
    edges,
    aggregate: { active: 0, completed: 0, failed: 0, interrupted: 0, totalTokens: 0 },
  }
}

describe('layoutGraph 拓扑序', () => {
  it('串行链:A→B→C 按依赖排好,各独占一层', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const b = makeRun('b', { createdAt: 2000 })
    const c = makeRun('c', { createdAt: 3000 })
    const edges = [
      { fromRunId: 'a', toRunId: 'b', kind: 'handoff' as const },
      { fromRunId: 'b', toRunId: 'c', kind: 'dependency' as const },
    ]
    // 乱序传入也应得到稳定拓扑序
    const layout = layoutGraph([c, a, b], edges)
    expect(layout.order.map((n) => n.runId)).toEqual(['a', 'b', 'c'])
    expect(layout.columns.map((col) => col.map((n) => n.runId))).toEqual([['a'], ['b'], ['c']])
  })

  it('并行同层:A 下游 B/C 并排,同层按 createdAt 谱序', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const c = makeRun('c', { createdAt: 3000 })
    const b = makeRun('b', { createdAt: 2000 })
    const edges = [
      { fromRunId: 'a', toRunId: 'b', kind: 'dependency' as const },
      { fromRunId: 'a', toRunId: 'c', kind: 'dependency' as const },
    ]
    const layout = layoutGraph([c, b, a], edges)
    expect(layout.order.map((n) => n.runId)).toEqual(['a', 'b', 'c'])
    // 第二层=b、c 并行同层
    expect(layout.columns).toHaveLength(2)
    expect(layout.columns[1]!.map((n) => n.runId)).toEqual(['b', 'c'])
  })

  it('菱形收拢:B/C 并行后汇入 D,D 落在第三层', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const b = makeRun('b', { createdAt: 2000 })
    const c = makeRun('c', { createdAt: 2500 })
    const d = makeRun('d', { createdAt: 3000 })
    const edges = [
      { fromRunId: 'a', toRunId: 'b', kind: 'dependency' as const },
      { fromRunId: 'a', toRunId: 'c', kind: 'dependency' as const },
      { fromRunId: 'b', toRunId: 'd', kind: 'handoff' as const },
      { fromRunId: 'c', toRunId: 'd', kind: 'handoff' as const },
    ]
    const layout = layoutGraph([d, c, b, a], edges)
    expect(layout.order.map((n) => n.runId)).toEqual(['a', 'b', 'c', 'd'])
    expect(layout.columns.map((col) => col.map((n) => n.runId))).toEqual([['a'], ['b', 'c'], ['d']])
    // D 的两条入边都在 incoming 里
    expect(layout.incoming.get('d')).toHaveLength(2)
  })

  it('跨层边不压短路径:depth 取最长路(A→C 直连同时 A→B→C,C 仍在第三层)', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const b = makeRun('b', { createdAt: 2000 })
    const c = makeRun('c', { createdAt: 3000 })
    const edges = [
      { fromRunId: 'a', toRunId: 'b', kind: 'dependency' as const },
      { fromRunId: 'b', toRunId: 'c', kind: 'dependency' as const },
      { fromRunId: 'a', toRunId: 'c', kind: 'dependency' as const },
    ]
    const layout = layoutGraph([a, b, c], edges)
    expect(layout.columns.map((col) => col.map((n) => n.runId))).toEqual([['a'], ['b'], ['c']])
  })

  it('环兜底:拓扑走不到的节点按 createdAt 接队尾,不崩不丢', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const b = makeRun('b', { createdAt: 2000 })
    const edges = [
      { fromRunId: 'a', toRunId: 'b', kind: 'dependency' as const },
      { fromRunId: 'b', toRunId: 'a', kind: 'dependency' as const },
    ]
    const layout = layoutGraph([a, b], edges)
    expect(layout.order.map((n) => n.runId).sort()).toEqual(['a', 'b'])
    expect(layout.order).toHaveLength(2)
  })

  it('非法边过滤:未知节点/自环边不进 incoming,也不影响定层', () => {
    const a = makeRun('a', { createdAt: 1000 })
    const b = makeRun('b', { createdAt: 2000 })
    const edges = [
      { fromRunId: 'ghost', toRunId: 'b', kind: 'handoff' as const },
      { fromRunId: 'a', toRunId: 'a', kind: 'dependency' as const },
      { fromRunId: 'a', toRunId: 'b', kind: 'dependency' as const },
    ]
    const layout = layoutGraph([a, b], edges)
    expect(layout.order.map((n) => n.runId)).toEqual(['a', 'b'])
    expect(layout.incoming.get('b')).toHaveLength(1)
    expect(layout.incoming.get('a') ?? []).toHaveLength(0)
  })
})

describe('upstreamLabelsOf 交接标识文案', () => {
  it('handoff 边出「来自:某角色(交棒)」,dependency 边出「依赖:某角色」', () => {
    const zhangfang = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const xiaobian = makeRun('b', { targetRoleName: '小编', createdAt: 2000 })
    const graph = graphOf(
      [zhangfang, xiaobian],
      [{ fromRunId: 'a', toRunId: 'b', kind: 'handoff' }],
    )
    const layout = layoutGraph(graph.nodes, graph.edges)
    expect(upstreamLabelsOf(graph, layout, 'b')).toEqual(['来自:账房(交棒)'])
    expect(upstreamLabelsOf(graph, layout, 'a')).toEqual([])

    const depGraph = graphOf(
      [zhangfang, xiaobian],
      [{ fromRunId: 'a', toRunId: 'b', kind: 'dependency' }],
    )
    const depLayout = layoutGraph(depGraph.nodes, depGraph.edges)
    expect(upstreamLabelsOf(depGraph, depLayout, 'b')).toEqual(['依赖:账房'])
  })

  it('多条入边逐条出行(handoff/依赖混合,顺序与边序一致)', () => {
    const a = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const c = makeRun('c', { targetRoleName: '管家', createdAt: 1500 })
    const b = makeRun('b', { createdAt: 2000 })
    const graph = graphOf(
      [a, c, b],
      [
        { fromRunId: 'a', toRunId: 'b', kind: 'handoff' },
        { fromRunId: 'c', toRunId: 'b', kind: 'dependency' },
      ],
    )
    const layout = layoutGraph(graph.nodes, graph.edges)
    expect(upstreamLabelsOf(graph, layout, 'b')).toEqual(['来自:账房(交棒)', '依赖:管家'])
  })
})
