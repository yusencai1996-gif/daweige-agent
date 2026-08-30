/**
 * A-28(0.5.0 第三批,PLAN §6.6):collab-panel-model 纯函数单测。
 * 覆盖:当前链选择五规则 / tab 选中回退 / 已运行时长 / 汇总口径 /
 * graph 合成(缓存边优先) / FLIP 变换计算 / reduced-motion 决策 / 三态裁决。
 */
import { describe, expect, it } from 'vitest'
import type { AgentRunGraph, AgentRunSummary } from '../../../src/shared/domain'
import {
  chainSummaryLine,
  composePanelGraph,
  computeCollabAggregate,
  computeFlipTransform,
  deriveDependencyEdges,
  elapsedMsOf,
  formatElapsedMs,
  panelTransitionKind,
  resolvePanelGraphId,
  resolvePanelView,
  resolveSelectedRunId,
} from '../../../src/renderer/features/manager/collab-panel-model'
import { layoutGraph } from '../../../src/renderer/features/manager/agent-run-graph-layout'

let seq = 0
function makeRun(
  runId: string,
  overrides?: Partial<AgentRunSummary>,
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
    createdAt: seq * 1000,
    startedAt: null,
    completedAt: null,
    updatedAt: seq * 1000,
    ...overrides,
  }
}

/* ============ 规则 1/2/3/4:当前链选择 ============ */
describe('resolvePanelGraphId(PLAN §6.2)', () => {
  it('空列表 → null(面板不渲染)', () => {
    expect(resolvePanelGraphId([], null)).toBeNull()
  })

  it('规则 1:有非终态 graph 时选 updatedAt 最新的活跃链,不选更近更新的终态链', () => {
    const oldActive = makeRun('a', { graphId: 'graph-active-old', status: 'running', updatedAt: 100 })
    const newTerminal = makeRun('b', { graphId: 'graph-terminal', status: 'completed', updatedAt: 200 })
    const newActive = makeRun('c', { graphId: 'graph-active-new', status: 'queued', updatedAt: 150 })
    expect(resolvePanelGraphId([oldActive, newTerminal, newActive], null)).toBe('graph-active-new')
  })

  it('规则 2:全部终态 → 选最近更新的一条', () => {
    const a = makeRun('a', { graphId: 'graph-1', status: 'completed', updatedAt: 100 })
    const b = makeRun('b', { graphId: 'graph-2', status: 'failed', updatedAt: 300 })
    const c = makeRun('c', { graphId: 'graph-2', status: 'completed', updatedAt: 250 })
    expect(resolvePanelGraphId([a, b, c], null)).toBe('graph-2')
  })

  it('规则 3:pin 的 graph 在列表里 → 恒选它(哪怕别的链更活跃)', () => {
    const pinnedChain = makeRun('a', { graphId: 'graph-pinned', status: 'completed', updatedAt: 100 })
    const activeChain = makeRun('b', { graphId: 'graph-active', status: 'running', updatedAt: 500 })
    expect(resolvePanelGraphId([pinnedChain, activeChain], 'graph-pinned')).toBe('graph-pinned')
  })

  it('规则 3 回退:pin 的 graph 已不在列表 → 回退自动选择(不悬空)', () => {
    const active = makeRun('b', { graphId: 'graph-active', status: 'running', updatedAt: 500 })
    expect(resolvePanelGraphId([active], 'graph-gone')).toBe('graph-active')
  })

  it('规则 4 形态:未 pin 时每次重算——新链出现活跃 run 即自动切换', () => {
    const oldChain = makeRun('a', { graphId: 'graph-old', status: 'running', updatedAt: 100 })
    expect(resolvePanelGraphId([oldChain], null)).toBe('graph-old')
    // 新链 push 到达(updatedAt 更晚)→ 未 pin,自动切到新链
    const newChain = makeRun('b', { graphId: 'graph-new', status: 'running', updatedAt: 200 })
    expect(resolvePanelGraphId([oldChain, newChain], null)).toBe('graph-new')
    // pin 住旧链 → 新链 push 不切换
    expect(resolvePanelGraphId([oldChain, newChain], 'graph-old')).toBe('graph-old')
  })

  it('graph 的 updatedAt 取成员节点最大值(整条链的「最近更新」)', () => {
    const a1 = makeRun('a1', { graphId: 'graph-1', status: 'completed', updatedAt: 100 })
    const a2 = makeRun('a2', { graphId: 'graph-1', status: 'completed', updatedAt: 900 })
    const b1 = makeRun('b1', { graphId: 'graph-2', status: 'completed', updatedAt: 500 })
    expect(resolvePanelGraphId([a1, a2, b1], null)).toBe('graph-1')
  })
})

/* ============ tab 选中回退 ============ */
describe('resolveSelectedRunId(PLAN §6.6)', () => {
  it('选中 run 仍在 → 保持', () => {
    const a = makeRun('a', { updatedAt: 100 })
    const b = makeRun('b', { updatedAt: 200 })
    expect(resolveSelectedRunId([a, b], 'a')).toBe('a')
  })

  it('选中 run 被删/链切换 → 回退到最近更新的节点', () => {
    const a = makeRun('a', { updatedAt: 100 })
    const b = makeRun('b', { updatedAt: 300 })
    const c = makeRun('c', { updatedAt: 200 })
    expect(resolveSelectedRunId([a, b, c], 'gone')).toBe('b')
  })

  it('新节点加入不影响已选 tab(选中仍在就不动)', () => {
    const a = makeRun('a', { updatedAt: 100 })
    const b = makeRun('b', { updatedAt: 900 })
    expect(resolveSelectedRunId([a, b], 'a')).toBe('a')
  })

  it('节点为空 → null(详情态收敛)', () => {
    expect(resolveSelectedRunId([], 'a')).toBeNull()
  })
})

/* ============ 已运行时长 ============ */
describe('elapsedMsOf + formatElapsedMs', () => {
  it('未启动(startedAt=null)→ null,不显示计时', () => {
    const run = makeRun('a', { status: 'awaiting-approval', startedAt: null })
    expect(elapsedMsOf(run, 999_999)).toBeNull()
  })

  it('运行中:now - startedAt(共享时钟驱动)', () => {
    const run = makeRun('a', { status: 'running', startedAt: 10_000 })
    expect(elapsedMsOf(run, 70_000)).toBe(60_000)
  })

  it('终态:completedAt - startedAt(定格,不随 now 走)', () => {
    const run = makeRun('a', {
      status: 'completed',
      startedAt: 10_000,
      completedAt: 40_000,
    })
    expect(elapsedMsOf(run, 999_999)).toBe(30_000)
  })

  it('interrupted 终态同走 completedAt(主进程终态迁移必写)', () => {
    const run = makeRun('a', {
      status: 'interrupted',
      interruptSource: 'user',
      startedAt: 0,
      completedAt: 5_000,
    })
    expect(elapsedMsOf(run, 999_999)).toBe(5_000)
  })

  it('契约外缺 completedAt 的终态退回 updatedAt;负值钳到 0', () => {
    const run = makeRun('a', {
      status: 'failed',
      startedAt: 10_000,
      completedAt: null,
      updatedAt: 25_000,
    })
    expect(elapsedMsOf(run, 999_999)).toBe(15_000)
    const skewed = makeRun('b', { status: 'running', startedAt: 50_000 })
    expect(elapsedMsOf(skewed, 40_000)).toBe(0)
  })

  it('格式化:<60s「N 秒」;<1h「M:SS」;再长「H:MM:SS」', () => {
    expect(formatElapsedMs(0)).toBe('0 秒')
    expect(formatElapsedMs(42_000)).toBe('42 秒')
    expect(formatElapsedMs(59_999)).toBe('59 秒')
    expect(formatElapsedMs(60_000)).toBe('1:00')
    expect(formatElapsedMs(205_000)).toBe('3:25')
    expect(formatElapsedMs(3_725_000)).toBe('1:02:05')
  })
})

/* ============ 汇总口径(与主进程 aggregate 基本一致;rejected 刻意单列,不并入 failed) ============ */
describe('computeCollabAggregate', () => {
  it('active 含 awaiting/queued/running/waiting;failed 只算 failed,rejected 单列「未派出」;token 求和', () => {
    const nodes = [
      makeRun('a', { status: 'awaiting-approval' }),
      makeRun('b', { status: 'queued' }),
      makeRun('c', { status: 'running' }),
      makeRun('d', { status: 'waiting', waitingReason: 'manager-wait' }),
      makeRun('e', { status: 'completed' }),
      makeRun('f', { status: 'failed' }),
      makeRun('g', { status: 'rejected' }),
      makeRun('h', { status: 'interrupted', interruptSource: 'user' }),
    ]
    nodes[4] = { ...nodes[4]!, usage: { ...nodes[4]!.usage, totalTokens: 100 } }
    nodes[5] = { ...nodes[5]!, usage: { ...nodes[5]!.usage, totalTokens: 50 } }
    const agg = computeCollabAggregate(nodes)
    expect(agg).toEqual({
      total: 8,
      active: 4,
      completed: 1,
      failed: 1,
      rejected: 1,
      interrupted: 1,
      totalTokens: 150,
    })
  })
})

/* ============ graph 合成 ============ */
describe('composePanelGraph + deriveDependencyEdges', () => {
  it('节点按 createdAt 谱序;缓存边(handoff)优先,未缓存时用 dependsOnRunIds 推导依赖边', () => {
    const b = makeRun('b', { createdAt: 2000, dependsOnRunIds: ['a'] })
    const a = makeRun('a', { createdAt: 1000 })
    const composed = composePanelGraph('graph-1', 'mgr-1', [b, a], undefined)
    expect(composed.nodes.map((n) => n.runId)).toEqual(['a', 'b'])
    expect(composed.edges).toEqual([{ fromRunId: 'a', toRunId: 'b', kind: 'dependency' }])

    const cached: AgentRunGraph = {
      graphId: 'graph-1',
      managerSessionId: 'mgr-1',
      nodes: [a, b],
      edges: [{ fromRunId: 'a', toRunId: 'b', kind: 'handoff' }],
      aggregate: { active: 0, completed: 2, failed: 0, interrupted: 0, totalTokens: 0 },
    }
    const withCache = composePanelGraph('graph-1', 'mgr-1', [b, a], cached)
    // 节点取活体(参数),边取缓存(handoff 不丢)
    expect(withCache.edges[0]!.kind).toBe('handoff')
  })

  it('依赖边推导过滤未知上游与自环', () => {
    const a = makeRun('a', { dependsOnRunIds: ['ghost', 'a'] })
    expect(deriveDependencyEdges([a])).toEqual([])
  })
})

describe('chainSummaryLine(小窗态摘要行)', () => {
  it('拓扑序角色名「→」串联 + 节点数', () => {
    const a = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const b = makeRun('b', { targetRoleName: '小编', createdAt: 2000, dependsOnRunIds: ['a'] })
    const layout = layoutGraph([a, b], deriveDependencyEdges([a, b]))
    expect(chainSummaryLine(layout.order)).toBe('账房 → 小编 · 2 节点')
  })
})

/* ============ FLIP 纯计算 ============ */
describe('computeFlipTransform(PLAN §6.5)', () => {
  it('从小卡到详情页:逆变换含位移+缩放,右上锚定', () => {
    const mini = { top: 12, right: 800, width: 220, height: 60 }
    const detail = { top: 12, right: 800, width: 440, height: 600 }
    // 右边对齐 → dx=0;高度差 10 倍、宽度差 2 倍
    expect(computeFlipTransform(mini, detail)).toBe('translate(0px, 0px) scale(0.5, 0.1)')
  })

  it('目标尺寸为 0 时按 1 兜底,不出 Infinity/NaN', () => {
    const from = { top: 0, right: 100, width: 100, height: 50 }
    const to = { top: 0, right: 100, width: 0, height: 0 }
    const transform = computeFlipTransform(from, to)
    expect(transform).not.toContain('Infinity')
    expect(transform).not.toContain('NaN')
    expect(transform).toBe('translate(0px, 0px) scale(100, 50)')
  })
})

describe('panelTransitionKind(reduced-motion)', () => {
  it('reduce → instant(直切状态);其余 → flip', () => {
    expect(panelTransitionKind(true)).toBe('instant')
    expect(panelTransitionKind(false)).toBe('flip')
  })
})

/* ============ 三态裁决 ============ */
describe('resolvePanelView', () => {
  it('无链 → null;详情开 → detail;手动收起 → mini;有活跃 → panel;全终态空闲 → mini', () => {
    const base = { detailOpen: false, minimized: false, manualExpanded: false }
    expect(resolvePanelView({ ...base, hasGraph: false, activeCount: 0 })).toBeNull()
    expect(
      resolvePanelView({ ...base, hasGraph: true, detailOpen: true, activeCount: 2 }),
    ).toBe('detail')
    // 详情态优先于收起态(卡入口 pin 时两标记同写也由 detail 赢)
    expect(
      resolvePanelView({ ...base, hasGraph: true, detailOpen: true, minimized: true, activeCount: 0 }),
    ).toBe('detail')
    expect(
      resolvePanelView({ ...base, hasGraph: true, minimized: true, activeCount: 3 }),
    ).toBe('mini')
    expect(resolvePanelView({ ...base, hasGraph: true, activeCount: 1 })).toBe('panel')
    expect(resolvePanelView({ ...base, hasGraph: true, activeCount: 0 })).toBe('mini')
  })

  it('手动展开(manualExpanded):全终态空闲链也回面板态;收起/详情优先级仍更高', () => {
    // 线框图:小窗态的展开图标必须点得开——全终态链不能恒回 mini
    expect(
      resolvePanelView({
        hasGraph: true,
        detailOpen: false,
        minimized: false,
        manualExpanded: true,
        activeCount: 0,
      }),
    ).toBe('panel')
    // 手动收起压过手动展开(同写时收起赢,面板收得回去)
    expect(
      resolvePanelView({
        hasGraph: true,
        detailOpen: false,
        minimized: true,
        manualExpanded: true,
        activeCount: 0,
      }),
    ).toBe('mini')
    // 详情态压过手动展开
    expect(
      resolvePanelView({
        hasGraph: true,
        detailOpen: true,
        minimized: false,
        manualExpanded: true,
        activeCount: 0,
      }),
    ).toBe('detail')
  })
})
