import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApprovalGate, DEFAULT_REJECT_REASON } from '../../../src/main/agent/approval-gate'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { PathPolicy } from '../../../src/main/files/path-policy'
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

/**
 * M4-02 集成验证:读免确认/越界读确认/写一律确认/拒绝附言回传/app-internal 拒绝。
 */

let root: string
let workspace: string
let appData: string
let events: AgentPushEvent[]
let broker: ApprovalBroker

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daweige-gate-'))
  workspace = join(root, 'ws')
  appData = join(root, 'userData')
  await Promise.all([mkdir(workspace), mkdir(join(appData, 'data'), { recursive: true })])
  events = []
  broker = new ApprovalBroker((e) => events.push(e))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

function gate() {
  const policy = new PathPolicy(workspace, appData)
  return createApprovalGate({ broker, sessionId: 's1', policy })
}

function ctx(name: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    toolCall: { name, id: 'tc-test' },
    args,
  } as unknown as BeforeToolCallContext
}

describe('approval gate(beforeToolCall)', () => {
  it('读工作区内文件:直接放行(undefined),不产生确认卡', async () => {
    const p = join(workspace, 'a.txt')
    await writeFile(p, 'x')
    const result = await gate()(ctx('read_file', { path: p }))
    expect(result).toBeUndefined()
    expect(broker.pendingCount()).toBe(0)
  })

  it('读工作区外文件:弹 outside-read 确认卡;批准放行', async () => {
    const outside = join(root, 'outside', 'secret.txt')
    await mkdir(join(root, 'outside'))
    await writeFile(outside, 'x')
    const g = gate()
    const pending = g(ctx('read_file', { path: outside }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    expect(card && card.type === 'approval_required' && card.request.kind).toBe('outside-read')
    expect(card && card.type === 'approval_required' && card.request.outsideWorkspace).toBe(true)

    broker.resolve({
      approvalId: card && card.type === 'approval_required' ? card.request.id : '',
      decision: 'approve',
    })
    expect(await pending).toBeUndefined()
  })

  it('读工作区外文件被拒绝(带附言):block reason 含附言', async () => {
    const outside = join(root, 'outside', 'secret.txt')
    await mkdir(join(root, 'outside'))
    await writeFile(outside, 'x')
    const g = gate()
    const pending = g(ctx('read_file', { path: outside }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const id = card && card.type === 'approval_required' ? card.request.id : ''
    broker.resolve({ approvalId: id, decision: 'reject', note: '这个文件别看' })
    const result = await pending
    expect(result).toMatchObject({ block: true })
    if (result && 'reason' in result && result.reason) {
      expect(result.reason).toContain('这个文件别看')
    }
  })

  it('写工作区内文件:也要确认(写一律确认)', async () => {
    const g = gate()
    const pending = g(ctx('write_file', { path: join(workspace, 'new.txt'), content: 'x' }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    expect(card && card.type === 'approval_required' && card.request.kind).toBe('write')
    expect(broker.pendingCount()).toBe(1)
    broker.resolve({
      approvalId: card && card.type === 'approval_required' ? card.request.id : '',
      decision: 'approve',
    })
    expect(await pending).toBeUndefined()
  })

  it('拒绝无附言:统一拒绝话术', async () => {
    const g = gate()
    const pending = g(ctx('delete_paths', { paths: [join(workspace, 'a.txt')] }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const id = card && card.type === 'approval_required' ? card.request.id : ''
    broker.resolve({ approvalId: id, decision: 'reject' })
    const result = await pending
    expect(result).toMatchObject({ block: true, reason: DEFAULT_REJECT_REASON })
  })

  it('delete_paths 卡片标记可恢复(回收站)', async () => {
    const g = gate()
    const pending = g(ctx('delete_paths', { paths: [join(workspace, 'a.txt'), join(workspace, 'b.txt')] }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    expect(req?.recoverable).toBe(true)
    expect(req?.itemCount).toBe(2)
    expect(req?.title).toContain('删除 2')
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve' })
    expect(await pending).toBeUndefined()
  })

  it('写应用内部数据:直接 block,不弹卡', async () => {
    const result = await gate()(ctx('write_file', { path: join(appData, 'data', 'evil.json'), content: '{}' }))
    expect(result).toMatchObject({ block: true })
    expect(broker.pendingCount()).toBe(0)
  })

  it('读应用内部数据:直接 block', async () => {
    const result = await gate()(ctx('read_file', { path: join(appData, 'data', 'memories.json') }))
    expect(result).toMatchObject({ block: true })
  })

  it('save_memory:放行不弹卡(应用内部记忆数据免确认)', async () => {
    const result = await gate()(ctx('save_memory', { text: '我妈生日是三月五号' }))
    expect(result).toBeUndefined()
    expect(broker.pendingCount()).toBe(0)
  })

  it('未登记工具:保守拒绝', async () => {
    const result = await gate()(ctx('exec_shell', { cmd: 'rm' }))
    expect(result).toMatchObject({ block: true })
  })

  it('move_paths:受影响数不含目标目录;越界目标标记', async () => {
    const g = gate()
    const outside = join(root, 'outside')
    await mkdir(outside)
    const pending = g(ctx('move_paths', {
      paths: [join(workspace, 'a.txt'), join(workspace, 'b.txt')],
      destination_dir: outside,
    }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    expect(req?.itemCount).toBe(2)
    expect(req?.outsideWorkspace).toBe(true)
    expect(req?.title).toContain('移动 2')
    broker.resolve({ approvalId: req?.id ?? '', decision: 'reject' })
    const result = await pending
    expect(result).toMatchObject({ block: true })
  })
})

describe('会话级授权(A-01 approve-session)', () => {
  it('approve-session 后:同会话同工具免再弹卡,直接放行', async () => {
    const g = gate()
    const first = g(ctx('write_file', { path: join(workspace, 'a.txt'), content: 'x' }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    expect(req?.toolName).toBe('write_file')
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve-session' })
    expect(await first).toBeUndefined()

    events.length = 0
    const second = await g(ctx('write_file', { path: join(workspace, 'b.txt'), content: 'y' }))
    expect(second).toBeUndefined()
    expect(events.some((e) => e.type === 'approval_required')).toBe(false)
    expect(broker.pendingCount()).toBe(0)
  })

  it('删除不吃会话授权:delete_paths 照常逐次弹卡', async () => {
    const p2 = join(workspace, 'a.txt')
    await writeFile(p2, 'x')
    const g = gate()
    const first = g(ctx('delete_paths', { paths: [p2] }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve-session' })
    await first

    events.length = 0
    const second = g(ctx('delete_paths', { paths: [p2] }))
    await waitForCard()
    const card2 = events.find((e) => e.type === 'approval_required')
    const req2 = card2 && card2.type === 'approval_required' ? card2.request : undefined
    expect(req2).toBeDefined()
    broker.resolve({ approvalId: req2?.id ?? '', decision: 'reject' })
    expect(await second).toMatchObject({ block: true })
  })

  it('clearSessionGrants(会话删除)后恢复逐次确认', async () => {
    const g = gate()
    const first = g(ctx('make_directory', { path: join(workspace, 'd1') }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve-session' })
    await first
    broker.clearSessionGrants('s1')

    events.length = 0
    const second = g(ctx('make_directory', { path: join(workspace, 'd2') }))
    await waitForCard()
    expect(events.some((e) => e.type === 'approval_required')).toBe(true)
    const card2 = events.find((e) => e.type === 'approval_required')
    const req2 = card2 && card2.type === 'approval_required' ? card2.request : undefined
    broker.resolve({ approvalId: req2?.id ?? '', decision: 'reject' })
    expect(await second).toMatchObject({ block: true })
  })
})

describe('approval gate:守则工具(0.2.0)', () => {
  it('edit_role_guardrails 永远弹 role-rules-edit 卡;批准放行', async () => {
    const pending = gate()(ctx('edit_role_guardrails', { old_string: 'A', new_string: 'B' }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    expect(req?.kind).toBe('role-rules-edit')
    expect(req?.title).toContain('守则')
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve' })
    expect(await pending).toBeUndefined()
  })

  it('拒绝:block 且附言回传模型', async () => {
    const pending = gate()(ctx('edit_role_guardrails', { old_string: 'A', new_string: 'B' }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    broker.resolve({ approvalId: req?.id ?? '', decision: 'reject', note: '这条规矩别动' })
    expect(await pending).toMatchObject({ block: true, reason: '用户拒绝了这次操作,并说:这条规矩别动' })
  })

  it('approve-session 不产生会话授权:第二次调用仍弹卡(不吃授权红线)', async () => {
    // 第一次:approve-session
    const first = gate()(ctx('edit_role_guardrails', { old_string: 'A', new_string: 'B' }))
    await waitForCard()
    let req = events.find((e) => e.type === 'approval_required')
    broker.resolve({
      approvalId: req && req.type === 'approval_required' ? req.request.id : '',
      decision: 'approve-session',
    })
    expect(await first).toBeUndefined()
    // 第二次:必须再次弹卡(授权未登记)
    events.length = 0
    const second = gate()(ctx('edit_role_guardrails', { old_string: 'C', new_string: 'D' }))
    await waitForCard()
    req = events.find((e) => e.type === 'approval_required')
    expect(req && req.type === 'approval_required').toBeDefined()
    broker.resolve({
      approvalId: req && req.type === 'approval_required' ? req.request.id : '',
      decision: 'reject',
    })
    expect(await second).toMatchObject({ block: true })
  })

  it('卡片描述带角色名(getRoleDisplayName 提供时)', async () => {
    const policy = new PathPolicy(workspace, appData)
    const g = createApprovalGate({
      broker,
      sessionId: 's1',
      policy,
      getRoleDisplayName: async () => '小编',
    })
    const pending = g(ctx('edit_role_guardrails', { old_string: 'A', new_string: 'B' }))
    await waitForCard()
    const card = events.find((e) => e.type === 'approval_required')
    const req = card && card.type === 'approval_required' ? card.request : undefined
    expect(req?.title).toContain('小编')
    broker.resolve({ approvalId: req?.id ?? '', decision: 'approve' })
    expect(await pending).toBeUndefined()
  })
})

async function waitForCard(): Promise<void> {
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'approval_required'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}
