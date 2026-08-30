/**
 * A-28(0.5.0 第三批,PLAN §6.6):面板组件 SSR 冒烟(renderToStaticMarkup,node 环境)。
 * 覆盖:纵向流(顺序/交棒标识/并行分组/时长) / tab 条(一角色一 tab、选中态) /
 * 小窗态(摘要行) / 面板态(汇总+流程+入口)。交互/动画在 E2E 与真机验,这里只锁结构。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentRunGraph, AgentRunSummary } from '../../../src/shared/domain'
import { VerticalRunFlow } from '../../../src/renderer/features/manager/VerticalRunFlow'
import { AgentRunTabs } from '../../../src/renderer/features/manager/AgentRunTabs'
import { CollaborationPanelCollapsed } from '../../../src/renderer/features/manager/CollaborationPanelCollapsed'
import type { CollabPanelActions } from '../../../src/renderer/features/manager/collab-panel-model'

let seq = 0
function makeRun(runId: string, overrides?: Partial<AgentRunSummary>): AgentRunSummary {
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

function graphOf(nodes: readonly AgentRunSummary[], edges: AgentRunGraph['edges']): AgentRunGraph {
  return {
    graphId: 'graph-1',
    managerSessionId: 'mgr-1',
    nodes,
    edges,
    aggregate: {
      active: nodes.filter((n) => ['awaiting-approval', 'queued', 'running', 'waiting'].includes(n.status)).length,
      completed: nodes.filter((n) => n.status === 'completed').length,
      failed: nodes.filter((n) => n.status === 'failed' || n.status === 'rejected').length,
      interrupted: nodes.filter((n) => n.status === 'interrupted').length,
      totalTokens: nodes.reduce((sum, n) => sum + n.usage.totalTokens, 0),
    },
  }
}

const NOW = 1_800_000_000_000

describe('VerticalRunFlow(纵向流程图)', () => {
  it('串行链:节点按拓扑序纵向排列,交棒边出「来自:账房(交棒)」连接行', () => {
    const a = makeRun('a', {
      targetRoleName: '账房',
      createdAt: 1000,
      startedAt: 1000,
      completedAt: 61_000,
    })
    const b = makeRun('b', {
      targetRoleName: '小编',
      createdAt: 2000,
      status: 'running',
      startedAt: NOW - 30_000,
      dependsOnRunIds: ['a'],
    })
    const graph = graphOf([a, b], [{ fromRunId: 'a', toRunId: 'b', kind: 'handoff' }])
    const html = renderToStaticMarkup(createElement(VerticalRunFlow, { graph, now: NOW }))
    const posA = html.indexOf('账房')
    const posB = html.indexOf('小编')
    expect(posA).toBeGreaterThanOrEqual(0)
    expect(posB).toBeGreaterThan(posA)
    expect(html).toContain('来自:账房(交棒)')
    // 运行中节点显示已运行时长(30 秒);完成节点定格 1:00
    expect(html).toContain('30 秒')
    expect(html).toContain('1:00')
  })

  it('并行同层:收进 is-parallel 分组并出「并行」小标,两节点都渲染', () => {
    const a = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const b = makeRun('b', { targetRoleName: '小编', createdAt: 2000, dependsOnRunIds: ['a'] })
    const c = makeRun('c', { targetRoleName: '管家', createdAt: 2500, dependsOnRunIds: ['a'] })
    const graph = graphOf(
      [a, b, c],
      [
        { fromRunId: 'a', toRunId: 'b', kind: 'dependency' },
        { fromRunId: 'a', toRunId: 'c', kind: 'dependency' },
      ],
    )
    const html = renderToStaticMarkup(createElement(VerticalRunFlow, { graph, now: NOW }))
    expect(html).toContain('is-parallel')
    expect(html).toContain('并行')
    expect(html).toContain('小编')
    expect(html).toContain('管家')
    // 依赖边文案
    expect(html).toContain('依赖:账房')
  })

  it('给了 onSelectRun 渲染成可点按钮,选中节点带 is-current 与 aria-current', () => {
    const a = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const b = makeRun('b', { targetRoleName: '小编', createdAt: 2000 })
    const graph = graphOf([a, b], [])
    const html = renderToStaticMarkup(
      createElement(VerticalRunFlow, {
        graph,
        now: NOW,
        selectedRunId: 'b',
        onSelectRun: () => undefined,
      }),
    )
    expect(html).toContain('collab-flow-node is-current')
    expect(html).toContain('aria-current="step"')
    // 不给 onSelectRun 时是静态行,不出 button
    const staticHtml = renderToStaticMarkup(createElement(VerticalRunFlow, { graph, now: NOW }))
    expect(staticHtml).not.toContain('<button')
  })

  it('追加计数:followupCount>0 的节点出「追加 N 次」', () => {
    const a = makeRun('a', { targetRoleName: '账房', followupCount: 2, status: 'running', startedAt: NOW - 5_000 })
    const html = renderToStaticMarkup(
      createElement(VerticalRunFlow, { graph: graphOf([a], []), now: NOW }),
    )
    expect(html).toContain('追加 2 次')
  })
})

describe('AgentRunTabs(角色 tab 条)', () => {
  it('一个节点一个 tab,选中 tab aria-selected=true', () => {
    const a = makeRun('a', { targetRoleName: '账房' })
    const b = makeRun('b', { targetRoleName: '小编', status: 'running' })
    const html = renderToStaticMarkup(
      createElement(AgentRunTabs, { nodes: [a, b], selectedRunId: 'b', onSelect: () => undefined }),
    )
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('账房')
    expect(html).toContain('小编')
  })
})

describe('CollaborationPanelCollapsed(小窗/面板态)', () => {
  const actions: CollabPanelActions = {
    expand: () => undefined,
    minimize: () => undefined,
    openDetail: () => undefined,
    closeDetail: () => undefined,
    selectRun: () => undefined,
  }

  it('小窗态:标题「协作链」+ 上次链摘要一行 + 整卡可点', () => {
    const a = makeRun('a', { targetRoleName: '账房', createdAt: 1000 })
    const b = makeRun('b', { targetRoleName: '小编', createdAt: 2000, dependsOnRunIds: ['a'] })
    const graph = graphOf([a, b], [{ fromRunId: 'a', toRunId: 'b', kind: 'handoff' }])
    const html = renderToStaticMarkup(
      createElement(CollaborationPanelCollapsed, {
        data: {
          graph,
          graphLoading: false,
          minimized: true,
          manualExpanded: false,
          detailOpen: false,
          selectedRunId: null,
          selectedDetail: undefined,
          selectedDetailLoading: false,
          pinned: false,
        },
        actions,
        now: NOW,
        mini: true,
      }),
    )
    expect(html).toContain('协作链')
    expect(html).toContain('账房 → 小编 · 2 节点')
    // 小窗态不出「查看详情」(那是面板态入口)
    expect(html).not.toContain('查看详情')
  })

  it('面板态:顶部汇总数字 + 流程 + 「查看详情」「收起」', () => {
    const a = makeRun('a', { targetRoleName: '账房', status: 'running', startedAt: NOW - 10_000 })
    const graph = graphOf([a], [])
    const html = renderToStaticMarkup(
      createElement(CollaborationPanelCollapsed, {
        data: {
          graph,
          graphLoading: false,
          minimized: false,
          manualExpanded: false,
          detailOpen: false,
          selectedRunId: null,
          selectedDetail: undefined,
          selectedDetailLoading: false,
          pinned: false,
        },
        actions,
        now: NOW,
        mini: false,
      }),
    )
    expect(html).toContain('1 节点')
    expect(html).toContain('进行中 1')
    expect(html).toContain('查看详情')
    expect(html).toContain('收起')
  })
})
