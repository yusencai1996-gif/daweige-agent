import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTurnInput, AgentTurnResult, AgentTurnRunner } from '../../../src/main/agent/agent-service'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { AgentRunQueryService } from '../../../src/main/manager/agent-run-query-service'
import { AgentRunRecovery } from '../../../src/main/manager/agent-run-recovery'
import { ManagerOrchestrator } from '../../../src/main/manager/manager-orchestrator'
import { ManagerCleanupService } from '../../../src/main/manager/manager-cleanup-service'
import { WorkerRunner } from '../../../src/main/manager/worker-runner'
import { canonicalWorkspaceKey } from '../../../src/main/roles/role-files'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { UsageStore } from '../../../src/main/usage/usage-store'
import { SYSTEM_MANAGER_ROLE_ID } from '../../../src/shared/domain/manager'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'

class FakeAgentTurnRunner implements AgentTurnRunner {
  private settle: ((result: AgentTurnResult) => void) | undefined
  readonly started: AgentTurnInput[] = []

  run(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.started.push(input)
    return new Promise((resolve) => { this.settle = resolve })
  }

  complete(finalText: string): void {
    const sessionId = this.started.at(-1)?.sessionId ?? 'internal'
    this.settle?.({ sessionId, status: 'completed', finalText })
  }

  abortSession(): void {}
}

let dir: string
let workspace: string
let roles: RoleRepository
let sessionsRepo: SessionRepository
let sessions: SessionService
let usage: UsageStore
let broker: ApprovalBroker
let runner: FakeAgentTurnRunner
let orchestrator: ManagerOrchestrator
let events: AgentPushEvent[]

const input = () => ({
  targetRoleId: 'agent-a1b2c3d4e5f6',
  userRequest: '整理工作区里的稿件',
  managerConclusions: ['保留原意'],
  taskBrief: '整理稿件并给出结论',
  acceptanceCriteria: ['结构清楚'],
  allowedWorkspacePaths: [workspace],
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'manager-orchestrator-'))
  workspace = join(dir, 'workspace')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace)
  roles = new RoleRepository(join(dir, 'roles.sqlite'))
  sessionsRepo = new SessionRepository(join(dir, 'sessions.sqlite'))
  await sessionsRepo.init()
  await roles.insertRole({
    role: {
      id: SYSTEM_MANAGER_ROLE_ID,
      kind: 'manager',
      displayName: '小柊',
      templateId: 'system-manager',
      homeRelPath: 'daweige/system/manager',
      guardrailsRelPath: 'guardrails.md',
      createdAt: 1,
      updatedAt: 1,
    },
    mounts: [],
    bindings: [{
      sessionId: 'manager-session',
      workspacePathSnapshot: dir,
      archivedAt: null,
      visibility: 'user',
      source: 'created',
      boundAt: 1,
    }],
  })
  await roles.insertRole({
    role: {
      id: 'agent-a1b2c3d4e5f6',
      kind: 'worker',
      displayName: '小编',
      templateId: 'writer',
      homeRelPath: 'daweige/agents/agent-a1b2c3d4e5f6',
      guardrailsRelPath: 'guardrails.md',
      createdAt: 2,
      updatedAt: 2,
    },
    mounts: [{
      workspacePath: workspace,
      canonicalKey: await canonicalWorkspaceKey(workspace),
      ordinal: 0,
      isPrimary: true,
      availability: 'available',
    }],
  })
  sessions = new SessionService(sessionsRepo, roles, undefined, dir)
  usage = new UsageStore(join(dir, 'usage.sqlite'))
  events = []
  broker = new ApprovalBroker((event) => events.push(event))
  runner = new FakeAgentTurnRunner()
  const query = new AgentRunQueryService(
    roles,
    sessions,
    { restoreChatMessages: vi.fn(async () => []) } as never,
    usage,
  )
  orchestrator = new ManagerOrchestrator({
    roles,
    sessions,
    approvals: broker,
    worker: new WorkerRunner(runner),
    query,
    userDataPath: dir,
    selection: async () => ({ providerId: 'kimi-coding', modelId: 'kimi-for-coding' }),
    emitEvent: (event) => events.push(event),
    isPackaged: false,
  })
})

afterEach(async () => {
  broker.abortAll()
  await usage.drainAndClose()
  await sessionsRepo.close()
  await roles.drainAndClose()
  rmSync(dir, { recursive: true, force: true })
})

describe('ManagerOrchestrator 派活主链', () => {
  it('简单回复不调用 spawn 时没有 run', async () => {
    expect(await orchestrator.list('manager-session')).toEqual([])
    expect(await roles.listAgentRuns()).toEqual([])
  })

  it('spawn 确认后建 internal binding，完成后 wait 返回保守结果与 usage', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    expect((await roles.listAgentRuns())[0]).toMatchObject({ status: 'awaiting-approval' })
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    const spawned = await spawning
    expect(spawned.status).toBe('running')
    const running = (await roles.listAgentRuns())[0]!
    expect(running.internalSessionId).toBeTruthy()
    expect((await roles.getBinding(running.internalSessionId!))?.visibility).toBe('internal')

    await orchestrator.markChildApproval(running.internalSessionId!, true)
    expect((await roles.getAgentRun(running.runId))?.waitingReason).toBe('user-approval')
    await orchestrator.markChildApproval(running.internalSessionId!, false)
    expect((await roles.getAgentRun(running.runId))?.status).toBe('running')

    runner.complete('没有结构化结果块，但保留为保守 fallback')
    await eventually(async () => (await roles.getAgentRun(running.runId))?.status === 'completed')
    const waited = await orchestrator.wait('manager-session', running.runId) as {
      result: { summary: string; unmetCriteria: string[] }
      usage: { totalTokens: number }
    }
    expect(waited.result.summary).toContain('保守 fallback')
    expect(waited.result.unmetCriteria).toEqual(['结构清楚'])
    expect(waited.usage.totalTokens).toBe(0)
  })

  it('拒绝派活进入 rejected 并释放串行槽', async () => {
    const first = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'reject', note: '先不派' })
    await expect(first).resolves.toMatchObject({ status: 'rejected' })
    expect((await roles.listAgentRuns())[0]).toMatchObject({ status: 'rejected' })

    const second = orchestrator.spawn('manager-session', input())
    const secondApproval = await nextDelegationApproval(2)
    broker.resolve({ approvalId: secondApproval.request.id, decision: 'reject' })
    await expect(second).resolves.toMatchObject({ status: 'rejected' })
  })

  it('awaiting 后目标角色被删除：批准返回人话工具错误且不留孤儿 internal 会话', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    await roles.deleteRoleRow('agent-a1b2c3d4e5f6')

    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })

    await expect(spawning).resolves.toMatchObject({
      status: 'rejected',
      error: '这次派活已失效(角色刚被删除或归档),请告知用户',
    })
    expect(await sessions.listAllMetadata()).toEqual([])
    expect((await roles.listBindingRows()).filter((row) => row.visibility === 'internal')).toEqual([])
  })

  it('退出 abortAll 后 drain 等待续体把 awaiting run 持久化为 rejected', async () => {
    const spawnTool = orchestrator.toolsForSession('manager-session').find((tool) => tool.name === 'spawn_role_agent')!
    const executing = spawnTool.execute('tool-call-1', input())
    await nextDelegationApproval()

    broker.abortAll('应用即将退出,本次未执行')
    await orchestrator.drain()

    await expect(executing).resolves.toBeDefined()
    expect((await roles.listAgentRuns())[0]).toMatchObject({
      status: 'rejected',
      failureMessage: '应用即将退出,本次未执行',
    })
  })

  it('角色清理删除 internal 与 run，但 usage 历史保留', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns())[0]!
    runner.complete('<daweige-delegation-result version="1">\n{"summary":"完成","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>')
    await eventually(async () => (await roles.getAgentRun(run.runId))?.status === 'completed')
    await usage.insertEvents([{
      sourceEntryId: 'child-entry',
      sessionId: run.internalSessionId!,
      provider: 'kimi-coding',
      modelId: 'kimi-for-coding',
      responseModelId: null,
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: null,
      totalTokens: 5,
      occurredAtMs: Date.now(),
      localDate: '2026-08-26',
      timezoneId: 'Asia/Shanghai',
      stopReason: 'stop',
    }], 'live')
    const cleanup = new ManagerCleanupService(
      roles,
      sessions,
      { disposeAgent: vi.fn() } as never,
      broker,
    )
    await cleanup.cleanupTargetRole('agent-a1b2c3d4e5f6')
    expect(await roles.listAgentRuns()).toEqual([])
    expect(await roles.getBinding(run.internalSessionId!)).toBeUndefined()
    expect(await sessions.findMeta(run.internalSessionId!)).toBeUndefined()
    expect((await usage.getSessionTotals([run.internalSessionId!])).get(run.internalSessionId!)?.totalTokens).toBe(5)
  })

  it('wait 超时不终止 child，再次 wait 可拿到完成结果', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns())[0]!
    vi.useFakeTimers()
    try {
      const firstWait = orchestrator.wait('manager-session', run.runId, 1)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(firstWait).resolves.toMatchObject({ timedOut: true })
    } finally {
      vi.useRealTimers()
    }
    const secondWait = orchestrator.wait('manager-session', run.runId, 10_000)
    await eventually(async () => (await roles.getAgentRun(run.runId))?.waitingReason === 'manager-wait')
    runner.complete('<daweige-delegation-result version="1">\n{"summary":"二次等待拿到结果","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>')
    await expect(secondWait).resolves.toMatchObject({
      timedOut: false,
      result: { summary: '二次等待拿到结果' },
    })
  })

  it('worker 完成与 wait 转 waiting 竞态时重读终态并返回结果', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns())[0]!
    const originalTransition = roles.transitionAgentRun.bind(roles)
    let raced = false
    vi.spyOn(roles, 'transitionAgentRun').mockImplementation(async (runId, transition) => {
      if (!raced && transition.status === 'waiting' && transition.waitingReason === 'manager-wait') {
        raced = true
        runner.complete('<daweige-delegation-result version="1">\n{"summary":"竞态完成","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>')
        await eventually(async () => (await roles.getAgentRun(run.runId))?.status === 'completed')
      }
      return originalTransition(runId, transition)
    })

    await expect(orchestrator.wait('manager-session', run.runId)).resolves.toMatchObject({
      timedOut: false,
      currentStatus: 'completed',
      result: { summary: '竞态完成' },
    })
  })

  it('queued 状态调用 wait 不因非法 waiting 转换抛错', async () => {
    await roles.createAgentRun({
      runId: 'run-0000000000000009',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    await roles.transitionAgentRun('run-0000000000000009', { status: 'queued' })
    await expect(orchestrator.wait('manager-session', 'run-0000000000000009')).resolves.toMatchObject({
      timedOut: true,
      currentStatus: 'queued',
    })
  })

  it('running child 详情复用活跃 pi Session，不因 writer lease 冲突返回 null', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns())[0]!
    await sessions.openPiSession(run.internalSessionId!)
    const detail = await new AgentRunQueryService(
      roles,
      sessions,
      { restoreChatMessages: vi.fn(async () => []) } as never,
      usage,
    ).getDetail(run.runId)
    expect(detail.childSession).not.toBeNull()
    expect(detail.childSession?.summary.id).toBe(run.internalSessionId)
  })

  it('E2E resume 在未声明场景时 fail closed', async () => {
    const previous = process.env.DAWEIGE_E2E_SCENARIO
    delete process.env.DAWEIGE_E2E_SCENARIO
    try {
      await expect(orchestrator.resumeAwaitingRunForE2E('run-0000000000000001')).rejects.toThrow(
        'E2E 派活夹具只能在未打包且已声明测试场景时使用',
      )
    } finally {
      if (previous === undefined) delete process.env.DAWEIGE_E2E_SCENARIO
      else process.env.DAWEIGE_E2E_SCENARIO = previous
    }
  })
})

describe('启动恢复与孤儿补偿', () => {
  it('遗留 running 收为 interrupted，并删除无 run 引用的 internal binding/pi 会话', async () => {
    const orphan = await sessions.createInternalSession({
      roleId: 'agent-a1b2c3d4e5f6',
      workspacePath: workspace,
      providerId: 'kimi-coding',
      modelId: 'kimi-for-coding',
    })
    await roles.createAgentRun({
      runId: 'run-0000000000000001',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    await roles.transitionAgentRun('run-0000000000000001', { status: 'queued' })
    await roles.transitionAgentRun('run-0000000000000001', {
      status: 'running',
      internalSessionId: 'missing-process-session',
    })
    const result = await new AgentRunRecovery(roles, sessions).reconcileOnStartup()
    expect(result).toEqual({ interrupted: 1, removedOrphans: 1 })
    expect((await roles.getAgentRun('run-0000000000000001'))?.status).toBe('interrupted')
    expect(await roles.getBinding(orphan.summary.id)).toBeUndefined()
    expect(await sessions.findMeta(orphan.summary.id)).toBeUndefined()
  })
})

async function nextDelegationApproval(expectedCount = 1) {
  await eventually(() => events.filter((event) => event.type === 'approval_required' && event.request.kind === 'delegation').length >= expectedCount)
  const approvals = events.filter((event) => event.type === 'approval_required' && event.request.kind === 'delegation')
  return approvals[expectedCount - 1] as Extract<AgentPushEvent, { type: 'approval_required' }>
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待测试状态超时')
}
