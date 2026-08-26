import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { createApprovalGate } from '../../../src/main/agent/approval-gate'
import {
  StrictDelegationPathPolicy,
  type DelegationPathViolation,
} from '../../../src/main/files/path-policy'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core'
import { FileOps } from '../../../src/main/files/file-ops'

let root: string
let rootA: string
let rootB: string
let outside: string
let appData: string
let violations: DelegationPathViolation[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daweige-strict-path-'))
  rootA = join(root, 'allowed-a')
  rootB = join(root, 'allowed-b')
  outside = join(root, 'outside')
  appData = join(root, 'userData')
  await Promise.all([mkdir(rootA), mkdir(rootB), mkdir(outside), mkdir(appData)])
  violations = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

function policy(): StrictDelegationPathPolicy {
  return new StrictDelegationPathPolicy([rootA, rootB], appData, (item) => {
    violations.push(item)
  })
}

function ctx(name: string, args: Record<string, unknown>): BeforeToolCallContext {
  return { toolCall: { name, id: 'tc-strict' }, args } as unknown as BeforeToolCallContext
}

describe('StrictDelegationPathPolicy', () => {
  it('多根、大小写、..、待创建尾段都按 realpath 判定', async () => {
    await writeFile(join(rootA, 'a.txt'), 'a')
    expect((await policy().classify(join(rootA.toUpperCase(), 'a.txt'))).zone).toBe('workspace')
    expect((await policy().classify(join(rootB, 'new', 'tail.txt'))).zone).toBe('workspace')
    expect((await policy().classify(join(rootA, '..', 'outside', 'x.txt'))).zone).toBe('outside')
    expect((await policy().classify(join(`${rootA}-similar`, 'x.txt'))).zone).toBe('outside')
  })

  it('Junction 跳出允许根时直接判越界', async () => {
    const link = join(rootA, 'junction-out')
    await symlink(outside, link, 'junction')
    await writeFile(join(outside, 'secret.txt'), 'x')
    expect((await policy().classify(join(link, 'secret.txt'))).zone).toBe('outside')
  })

  it('批准后允许根本身被 Junction 置换时读写全拒绝并记录 violation', async () => {
    const p = policy()
    // 先完成一次检查，模拟批准时该目录仍是原目录。
    expect((await p.classify(join(rootA, 'before.txt'))).zone).toBe('workspace')
    await rm(rootA, { recursive: true, force: true })
    await symlink(outside, rootA, 'junction')
    await writeFile(join(outside, 'secret.txt'), 'secret')

    await expect(p.classify(join(rootA, 'secret.txt'))).rejects.toThrow(
      '允许的文件夹在批准后被移动或替换,为安全起见这次不执行',
    )
    const read = await p.preflight([join(rootA, 'secret.txt')], 'read_file', 'read')
    const write = await p.preflight([join(rootA, 'new.txt')], 'write_file', 'write')
    expect(read).toEqual({
      allowed: false,
      reason: '允许的文件夹在批准后被移动或替换,为安全起见这次不执行',
    })
    expect(write).toEqual(read)
    expect(violations).toHaveLength(2)
    expect(violations.map((item) => item.operation)).toEqual(['read', 'write'])
    expect(violations.every((item) => item.reason.includes('批准后被移动或替换'))).toBe(true)
  })

  it('批量写全量预检:一项越界则整批拒绝并记录 canonical violation', async () => {
    const p = policy()
    const result = await p.preflight(
      [join(rootA, 'ok.txt'), join(outside, 'bad.txt'), join(appData, 'private.json')],
      'move_paths',
      'write',
    )
    expect(result).toMatchObject({ allowed: false })
    expect(violations).toHaveLength(2)
    expect(violations[0]).toMatchObject({ toolName: 'move_paths', operation: 'write' })
    expect(violations.map((item) => item.path)).toContain(join(outside, 'bad.txt'))
    expect(JSON.stringify(violations)).not.toContain('file content')
  })

  it('FileOps 纵深防御:绕过 gate 的批量 move 仍整批不执行', async () => {
    const insideSource = join(rootA, 'inside.txt')
    const outsideSource = join(outside, 'outside.txt')
    await Promise.all([writeFile(insideSource, 'a'), writeFile(outsideSource, 'b')])
    const ops = new FileOps(policy())
    await expect(ops.movePaths([insideSource, outsideSource], rootB)).rejects.toThrow('超出')
    expect(await ops.fileExists(insideSource)).toBe(true)
    expect(await ops.fileExists(outsideSource)).toBe(true)
  })

  it('delegated outside read 不进 Broker,直接 block 并记录 violation', async () => {
    const events: AgentPushEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const gate = createApprovalGate({
      broker,
      sessionId: 'internal-child-1',
      surfaceSessionId: 'manager-user-1',
      policy: policy(),
    })
    const result = await gate(ctx('read_file', { path: join(outside, 'secret.txt') }))
    expect(result).toMatchObject({ block: true })
    expect(broker.pendingCount()).toBe(0)
    expect(events.some((event) => event.type === 'approval_required')).toBe(false)
    expect(violations).toHaveLength(1)
  })

  it('child 域内写卡 owner=internal,surface=manager', async () => {
    const events: AgentPushEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const gate = createApprovalGate({
      broker,
      sessionId: 'internal-child-1',
      surfaceSessionId: 'manager-user-1',
      policy: policy(),
    })
    const pending = gate(ctx('write_file', { path: join(rootB, 'out.txt'), content: 'x' }))
    // gate 内部有真实文件 IO(realpath 判域),微任务 flush 等不到;沿用 approval-gate 测试的轮询模式
    let card = events.find((event) => event.type === 'approval_required')
    for (let i = 0; i < 100 && !card; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      card = events.find((event) => event.type === 'approval_required')
    }
    expect(card).toMatchObject({
      type: 'approval_required',
      sessionId: 'internal-child-1',
      surfaceSessionId: 'manager-user-1',
    })
    if (!card || card.type !== 'approval_required') throw new Error('未产生确认卡')
    broker.resolve({ approvalId: card.request.id, decision: 'approve' })
    expect(await pending).toBeUndefined()
  })
})
