import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalBroker,
} from '../../../src/main/agent/approval-broker'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

function setup() {
  const events: AgentPushEvent[] = []
  return { events, broker: new ApprovalBroker((event) => events.push(event)) }
}

function delegation(broker: ApprovalBroker) {
  return broker.requestDelegation({
    sessionId: 'manager-s1',
    runId: 'run-0123456789abcdef',
    targetRoleId: 'agent-012345abcdef',
    targetRoleName: '账房',
    taskBrief: '汇总销售表',
    allowedWorkspacePaths: ['C:\\sales'],
    acceptanceCriteria: ['总额', '异常行'],
    title: '派给账房:汇总销售表',
    description: '允许操作 C:\\sales',
  })
}

function request(events: AgentPushEvent[]) {
  const event = events.find((item) => item.type === 'approval_required')
  if (!event || event.type !== 'approval_required') throw new Error('没有派活确认卡')
  return event.request
}

describe('ApprovalBroker delegation', () => {
  it('approve=派出,reject=不派', async () => {
    const approved = setup()
    const a = delegation(approved.broker)
    approved.broker.resolve({ approvalId: request(approved.events).id, decision: 'approve' })
    await expect(a).resolves.toEqual({ decision: 'approve' })

    const rejected = setup()
    const r = delegation(rejected.broker)
    rejected.broker.resolve({ approvalId: request(rejected.events).id, decision: 'reject' })
    await expect(r).resolves.toEqual({ decision: 'reject' })
  })

  it('超时 fail closed 收成 rejected outcome', async () => {
    vi.useFakeTimers()
    try {
      const { broker } = setup()
      const pending = delegation(broker)
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1)
      await expect(pending).resolves.toMatchObject({ decision: 'reject', timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('delegation 即使收 approve-session 也永不登记 grant', async () => {
    const { broker, events } = setup()
    const pending = delegation(broker)
    broker.resolve({ approvalId: request(events).id, decision: 'approve-session' })
    await expect(pending).resolves.toEqual({ decision: 'approve' })
    expect(broker.hasSessionGrant('manager-s1', 'spawn_role_agent')).toBe(false)
  })

  it('child approve-session 只归 owner internal session,总管和下一 run 不继承', async () => {
    const { broker, events } = setup()
    const pending = broker.request({
      sessionId: 'child-a',
      surfaceSessionId: 'manager-s1',
      kind: 'write',
      toolName: 'write_file',
      title: '写文件',
      description: '写入域内文件',
      itemCount: 1,
      samplePaths: ['C:\\sales\\a.txt'],
      recoverable: false,
      outsideWorkspace: false,
    })
    broker.resolve({ approvalId: request(events).id, decision: 'approve-session' })
    await pending
    expect(broker.hasSessionGrant('child-a', 'write_file')).toBe(true)
    expect(broker.hasSessionGrant('manager-s1', 'write_file')).toBe(false)
    expect(broker.hasSessionGrant('child-b', 'write_file')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'approval_resolved',
      sessionId: 'child-a',
      surfaceSessionId: 'manager-s1',
    })
  })
})
