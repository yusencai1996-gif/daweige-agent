import { describe, expect, it } from 'vitest'
import type { AgentRunSummary, ChatMessage } from '../../../src/shared/domain'
import { mergeTimeline } from '../../../src/renderer/features/manager/conversation-timeline'

function message(partial: Partial<ChatMessage> & { readonly id: string }): ChatMessage {
  return {
    kind: 'chat',
    role: 'assistant',
    text: partial.id,
    createdAt: 0,
    ...partial,
  } as ChatMessage
}

function run(partial: Partial<AgentRunSummary> & { readonly runId: string }): AgentRunSummary {
  return {
    managerSessionId: 'demo-session-manager',
    targetRoleId: 'agent-a1b2c3d4e5f6',
    targetRoleName: '小编',
    internalSessionId: null,
    parentRunId: null,
    status: 'completed',
    waitingReason: null,
    graphId: 'graph-0123456789abcdef',
    dependsOnRunIds: [],
    queueReason: null,
    followupCount: 0,
    interruptSource: null,
    taskBrief: partial.runId,
    allowedWorkspacePaths: [],
    usage: {
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: 0,
    ...partial,
  }
}

/** 把时间线压成可断言行:u-/a-/e- 消息 id,r- runId。 */
function flatten(items: ReturnType<typeof mergeTimeline>): string[] {
  return items.map((item) =>
    item.kind === 'run' ? `r-${item.run.runId}` : `${item.message.role[0]}-${item.message.id}`,
  )
}

describe('mergeTimeline(PLAN §10.2)', () => {
  it('消息与派活卡按 createdAt 混排', () => {
    const items = mergeTimeline(
      [message({ id: 'm1', role: 'user', createdAt: 100 }), message({ id: 'm2', createdAt: 300 })],
      [run({ runId: 'run1', createdAt: 200 })],
    )
    expect(flatten(items)).toEqual(['u-m1', 'r-run1', 'a-m2'])
  })

  it('同毫秒顺序:user → assistant → run 卡', () => {
    const items = mergeTimeline(
      [message({ id: 'm2', createdAt: 500 }), message({ id: 'm1', role: 'user', createdAt: 500 })],
      [run({ runId: 'run1', createdAt: 500 })],
    )
    expect(flatten(items)).toEqual(['u-m1', 'a-m2', 'r-run1'])
  })

  it('空 run 列表原样保留消息;空消息也能只渲染 run 卡', () => {
    const onlyMessages = mergeTimeline([message({ id: 'm1', createdAt: 1 })], [])
    expect(flatten(onlyMessages)).toEqual(['a-m1'])
    const onlyRuns = mergeTimeline([], [run({ runId: 'run1', createdAt: 1 })])
    expect(flatten(onlyRuns)).toEqual(['r-run1'])
  })

  it('完全同毫秒同类的多条保持输入顺序(稳定)', () => {
    const items = mergeTimeline(
      [
        message({ id: 'm1', role: 'user', createdAt: 7 }),
        message({ id: 'm2', role: 'user', createdAt: 7 }),
      ],
      [run({ runId: 'run1', createdAt: 7 }), run({ runId: 'run2', createdAt: 7 })],
    )
    expect(flatten(items)).toEqual(['u-m1', 'u-m2', 'r-run1', 'r-run2'])
  })
})
