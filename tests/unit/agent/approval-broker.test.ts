import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, APPROVAL_TIMEOUT_MS } from '../../../src/main/agent/approval-broker'
import { ApprovalNotFoundError } from '../../../src/main/agent/approval-broker'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

/**
 * M4-02 验证标准:未批准前无文件变化(由调用方保证,这里验证 broker 语义);
 * 拒绝附言非空时进入 outcome.note;超时/abort 收尾;伪造/重复响应拒绝;不串单。
 */

function setup() {
  const events: AgentPushEvent[] = []
  const broker = new ApprovalBroker((e) => events.push(e))
  return { broker, events }
}

function lastApprovalRequest(events: AgentPushEvent[]) {
  const found = [...events].reverse().find((e) => e.type === 'approval_required')
  // 本文件只测文件卡(broker.request 产物);delegation(0.3.0)/command(0.4.0)卡走各自专属入口
  if (
    found &&
    found.type === 'approval_required' &&
    found.request.kind !== 'delegation' &&
    found.request.kind !== 'command' &&
    found.request.kind !== 'skill-candidate' &&
    found.request.kind !== 'skill-install'
  )
    return found.request
  throw new Error('没有 approval_required 事件')
}

describe('ApprovalBroker', () => {
  it('批准:outcome 为 approve,推送 approval_required + approval_resolved', async () => {
    const { broker, events } = setup()
    const pending = broker.request({
      sessionId: 's1',
      kind: 'move',
      title: '我要移动 38 个文件',
      description: '把这 38 张图片移到按月份建好的文件夹里',
      itemCount: 38,
      samplePaths: ['C:\\ws\\img-001.jpg'],
      recoverable: true,
      outsideWorkspace: false,
    })
    const req = lastApprovalRequest(events)
    expect(req.title).toBe('我要移动 38 个文件')
    expect(req.samplePaths).toHaveLength(1)

    broker.resolve({ approvalId: req.id, decision: 'approve' })
    await expect(pending).resolves.toEqual({ decision: 'approve' })
    expect(events.at(-1)).toMatchObject({
      type: 'approval_resolved',
      approvalId: req.id,
      decision: 'approve',
    })
  })

  it('拒绝(无附言):outcome 无 note', async () => {
    const { broker, events } = setup()
    const pending = broker.request({
      sessionId: 's1',
      kind: 'delete',
      title: '我要删除 3 个文件',
      description: '删除这 3 个临时文件,删除会进回收站,可以恢复',
      itemCount: 3,
      samplePaths: [],
      recoverable: true,
      outsideWorkspace: false,
    })
    const req = lastApprovalRequest(events)
    broker.resolve({ approvalId: req.id, decision: 'reject' })
    await expect(pending).resolves.toEqual({ decision: 'reject' })
  })

  it('拒绝附言非空:note 进入 outcome(回传模型的 block reason)', async () => {
    const { broker, events } = setup()
    const pending = broker.request({
      sessionId: 's1',
      kind: 'write',
      title: '我要写入 1 个文件',
      description: '新建 归档说明.txt',
      itemCount: 1,
      samplePaths: ['C:\\ws\\归档说明.txt'],
      recoverable: false,
      outsideWorkspace: false,
    })
    const req = lastApprovalRequest(events)
    broker.resolve({ approvalId: req.id, decision: 'reject', note: '二月的先别动' })
    await expect(pending).resolves.toEqual({ decision: 'reject', note: '二月的先别动' })
  })

  it('伪造确认 ID / 重复响应 → ApprovalNotFoundError', async () => {
    const { broker, events } = setup()
    const pending = broker.request({
      sessionId: 's1',
      kind: 'rename',
      title: '我要重命名 1 个文件',
      description: '把 a.txt 改名为 b.txt',
      itemCount: 1,
      samplePaths: [],
      recoverable: false,
      outsideWorkspace: false,
    })
    // 伪造 ID
    expect(() => broker.resolve({ approvalId: 'not-exist-id', decision: 'approve' })).toThrow(
      ApprovalNotFoundError,
    )
    const req = lastApprovalRequest(events)
    broker.resolve({ approvalId: req.id, decision: 'approve' })
    await pending
    // 重复响应同一 ID
    expect(() => broker.resolve({ approvalId: req.id, decision: 'approve' })).toThrow(
      ApprovalNotFoundError,
    )
  })

  it('会话 abort:该会话待确认按拒绝收尾,其他会话不受影响(不串单)', async () => {
    const { broker, events } = setup()
    const p1 = broker.request({
      sessionId: 's1', kind: 'move', title: 't1', description: 'd',
      itemCount: 1, samplePaths: [], recoverable: true, outsideWorkspace: false,
    })
    const p2 = broker.request({
      sessionId: 's2', kind: 'move', title: 't2', description: 'd',
      itemCount: 1, samplePaths: [], recoverable: true, outsideWorkspace: false,
    })
    broker.abortAllForSession('s1')
    await expect(p1).resolves.toMatchObject({ decision: 'reject' })
    expect(broker.pendingCount()).toBe(1)
    // s2 还在等
    const req2 = lastApprovalRequest(events)
    broker.resolve({ approvalId: req2.id, decision: 'approve' })
    await expect(p2).resolves.toEqual({ decision: 'approve' })
  })

  it('超时按拒绝收尾(fast timer 注入)', async () => {
    vi.useFakeTimers()
    try {
      const { broker, events } = setup()
      const pending = broker.request({
        sessionId: 's1', kind: 'delete', title: 't', description: 'd',
        itemCount: 1, samplePaths: [], recoverable: true, outsideWorkspace: false,
      })
      vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 100)
      await expect(pending).resolves.toMatchObject({
        decision: 'reject',
        timedOut: true,
      })
      expect(broker.pendingCount()).toBe(0)
      expect(events.some((e) => e.type === 'approval_resolved')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
