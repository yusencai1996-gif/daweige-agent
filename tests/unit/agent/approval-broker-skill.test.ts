import { describe, expect, it } from 'vitest'
import { ApprovalBroker, ApprovalResponseMismatchError } from '../../../src/main/agent/approval-broker'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

describe('ApprovalBroker skill approvals', () => {
  it('候选防篡改、禁止 approve-session，合法选择回传 optionId', async () => {
    const events: AgentPushEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const pending = broker.requestSkillCandidate({
      sessionId: 's1', title: '选技能', description: '', query: 'meeting', toolCallId: 'call-1',
      candidates: [{ optionId: 'option-123', registryId: 'curated', slug: 'safe', displayName: 'Safe', summary: '', license: 'MIT' }],
    })
    const event = events[0]
    if (!event || event.type !== 'approval_required') throw new Error('没有确认卡')
    expect(() => broker.resolve({ approvalId: event.request.id, decision: 'approve', selectedOptionId: 'forged' })).toThrow(ApprovalResponseMismatchError)
    expect(() => broker.resolve({ approvalId: event.request.id, decision: 'approve-session', selectedOptionId: 'option-123' })).toThrow(ApprovalResponseMismatchError)
    broker.resolve({ approvalId: event.request.id, decision: 'approve', selectedOptionId: 'option-123' })
    await expect(pending).resolves.toEqual({ decision: 'approve', selectedOptionId: 'option-123' })
  })

  it('install 禁止 selectedOptionId，AbortSignal 立即收尾', async () => {
    const events: AgentPushEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const abort = new AbortController()
    const pending = broker.requestSkillInstall({
      sessionId: 's1', title: '安装', description: '', toolCallId: 'call-2',
      candidate: { optionId: 'option-123', registryId: 'curated', slug: 'safe', displayName: 'Safe', summary: '' },
      markdownPreview: '# ok', markdownBytes: 4, previewTruncated: false,
      targetLogicalLocation: 'daweige-skill://global/safe/SKILL.md', signal: abort.signal,
    })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ decision: 'reject' })
    expect(broker.pendingCount()).toBe(0)
  })
})
