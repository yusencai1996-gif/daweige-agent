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
  /** 按 session 定向 settle(并行多条派活时可以只完成指定的那条)。 */
  private readonly settles = new Map<string, (result: AgentTurnResult) => void>()
  readonly started: AgentTurnInput[] = []
  readonly steered: Array<{ sessionId: string; text: string }> = []

  run(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.started.push(input)
    return new Promise((resolve) => {
      this.settles.set(input.sessionId, resolve)
    })
  }

  complete(finalText: string, sessionId?: string): void {
    const key = sessionId ?? this.started.at(-1)?.sessionId ?? 'internal'
    this.settles.get(key)?.({ sessionId: key, status: 'completed', finalText })
    this.settles.delete(key)
  }

  abortSession(): void {}

  async steerSession(sessionId: string, text: string): Promise<void> {
    this.steered.push({ sessionId, text })
  }
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
let query: AgentRunQueryService
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
  // appData 与工作区必须互不包含(生产两者分离;父目录会让授权根内的产物全落 app-internal 区)
  mkdirSync(join(dir, 'appdata'))
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
  query = new AgentRunQueryService(
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
    userDataPath: join(dir, 'appdata'),
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
    const waited = await orchestrator.wait('manager-session', [running.runId]) as {
      runs: Array<{ result?: { summary: string; unmetCriteria: string[] }; usage: { totalTokens: number } }>
    }
    expect(waited.runs[0]!.result!.summary).toContain('保守 fallback')
    expect(waited.runs[0]!.result!.unmetCriteria).toEqual(['结构清楚'])
    expect(waited.runs[0]!.usage.totalTokens).toBe(0)
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
      const firstWait = orchestrator.wait('manager-session', [run.runId], 1)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(firstWait).resolves.toMatchObject({ timedOut: true })
    } finally {
      vi.useRealTimers()
    }
    const secondWait = orchestrator.wait('manager-session', [run.runId], 10_000)
    await eventually(async () => (await roles.getAgentRun(run.runId))?.waitingReason === 'manager-wait')
    runner.complete('<daweige-delegation-result version="1">\n{"summary":"二次等待拿到结果","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>')
    await expect(secondWait).resolves.toMatchObject({
      timedOut: false,
      runs: [{ runId: run.runId, status: 'completed', result: { summary: '二次等待拿到结果' } }],
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

    await expect(orchestrator.wait('manager-session', [run.runId])).resolves.toMatchObject({
      timedOut: false,
      runs: [{ runId: run.runId, status: 'completed', result: { summary: '竞态完成' } }],
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
    await expect(orchestrator.wait('manager-session', ['run-0000000000000009'])).resolves.toMatchObject({
      timedOut: true,
      runs: [{ runId: 'run-0000000000000009', status: 'queued' }],
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
    ).getDetail(run.runId, 'manager-session')
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

  it('并行调度:不同根的两条派活同时 running;同根第二条排队,首条完成后自动补位(codex 复验整改)', async () => {
    // 第二个 worker 挂互不重叠的根(并行判定看 canonical roots,不看角色)
    const mkdirSync = (await import('node:fs')).mkdirSync
    const otherWorkspace = join(dir, 'workspace-other')
    mkdirSync(otherWorkspace)
    await roles.insertRole({
      role: {
        id: 'agent-b2c3d4e5f6a7',
        kind: 'worker',
        displayName: '账房',
        templateId: 'accountant',
        homeRelPath: 'daweige/agents/agent-b2c3d4e5f6a7',
        guardrailsRelPath: 'guardrails.md',
        createdAt: 3,
        updatedAt: 3,
      },
      mounts: [{
        workspacePath: otherWorkspace,
        canonicalKey: await canonicalWorkspaceKey(otherWorkspace),
        ordinal: 0,
        isPrimary: true,
        availability: 'available',
      }],
    })

    // 两条互不重叠根的派活:批准后都直接 running(并发上限 3 内)
    const first = orchestrator.spawn('manager-session', input())
    const firstApproval = await nextDelegationApproval()
    broker.resolve({ approvalId: firstApproval.request.id, decision: 'approve' })
    await expect(first).resolves.toMatchObject({ status: 'running' })

    const second = orchestrator.spawn('manager-session', {
      ...input(),
      targetRoleId: 'agent-b2c3d4e5f6a7',
      allowedWorkspacePaths: [otherWorkspace],
    })
    const secondApproval = await nextDelegationApproval(2)
    broker.resolve({ approvalId: secondApproval.request.id, decision: 'approve' })
    await expect(second).resolves.toMatchObject({ status: 'running' })

    // 同根第三条:租约互斥 → queued(workspace-lock),拿到人话排队原因
    const third = orchestrator.spawn('manager-session', input())
    const thirdApproval = await nextDelegationApproval(3)
    broker.resolve({ approvalId: thirdApproval.request.id, decision: 'approve' })
    await expect(third).resolves.toMatchObject({
      status: 'queued',
      message: expect.stringContaining('排队'),
    })
    const thirdRun = (await roles.listAgentRuns()).find((run) => run.status === 'queued')!
    expect(thirdRun.queueReason).toBe('workspace-lock')

    // 首条完成(释放租约)→ 调度器自动启动排队的第三条(此前永久 queued 的复验残留场景)
    runner.complete(
      '<daweige-delegation-result version="1">\n{"summary":"第一条完成","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>',
      runner.started[0]!.sessionId,
    )
    await eventually(async () => (await roles.getAgentRun(thirdRun.runId))?.status === 'running')
    expect(runner.started.length).toBe(3)
  })

  it('send_message 交棒:完成 run 的 DB 定论进下游信封,handoff 边/input 落库,新卡照弹(PLAN §6.3)', async () => {
    // 第二个 worker(交棒下游)
    const mkdirSync = (await import('node:fs')).mkdirSync
    const otherWorkspace = join(dir, 'workspace-other')
    mkdirSync(otherWorkspace)
    await roles.insertRole({
      role: {
        id: 'agent-b2c3d4e5f6a7',
        kind: 'worker',
        displayName: '账房',
        templateId: 'accountant',
        homeRelPath: 'daweige/agents/agent-b2c3d4e5f6a7',
        guardrailsRelPath: 'guardrails.md',
        createdAt: 3,
        updatedAt: 3,
      },
      mounts: [{
        workspacePath: otherWorkspace,
        canonicalKey: await canonicalWorkspaceKey(otherWorkspace),
        ordinal: 0,
        isPrimary: true,
        availability: 'available',
      }],
    })

    // 第一棒:派给小编 → 完成(带结构化定论;artifact 必须在授权根内,越界声明会被结果校验剔除)
    const { writeFileSync } = await import('node:fs')
    const artifactPath = join(workspace, 'summary.md')
    writeFileSync(artifactPath, '门店销售总计 20370')
    const first = orchestrator.spawn('manager-session', input())
    const firstApproval = await nextDelegationApproval()
    broker.resolve({ approvalId: firstApproval.request.id, decision: 'approve' })
    await expect(first).resolves.toMatchObject({ status: 'running' })
    const firstRun = (await roles.listAgentRuns()).find((run) => run.status === 'running')!
    runner.complete(
      `<daweige-delegation-result version="1">\n{"summary":"账目已汇总","conclusions":["门店销售总计 20370"],"artifactPaths":["${artifactPath.replace(/\\/g, '\\\\')}"],"unmetCriteria":[],"detailData":"城中店 7850;东门店 6700;南山店 5820"}\n</daweige-delegation-result>`,
      firstRun.internalSessionId!,
    )
    await eventually(async () => (await roles.getAgentRun(firstRun.runId))?.status === 'completed')
    expect((await roles.getAgentRun(firstRun.runId))?.result?.artifactPaths).toEqual([artifactPath])
    expect((await roles.getAgentRun(firstRun.runId))?.result?.detailData).toBe('城中店 7850;东门店 6700;南山店 5820')

    // 交棒:账房(已完成)→ 小编…不,下游是新 worker(这里用账房角色作为下游演示即可,角色不同才真实)
    const handoff = orchestrator.sendMessage('manager-session', {
      sourceRunIds: [firstRun.runId],
      targetRoleId: 'agent-b2c3d4e5f6a7',
      managerConclusion: '以汇总数据为准写通报',
      taskBrief: '把账房汇总写成一篇门店通报',
      acceptanceCriteria: ['数字与汇总一致'],
      allowedWorkspacePaths: [otherWorkspace],
    })
    const handoffApproval = await nextDelegationApproval(2)
    broker.resolve({ approvalId: handoffApproval.request.id, decision: 'approve' })
    await expect(handoff).resolves.toMatchObject({ status: 'running' })

    const runs = await roles.listAgentRuns()
    const second = runs.find((run) => run.parentRunId === firstRun.runId)!
    expect(second).toBeTruthy()
    // 下游信封:DB 权威事实全集(summary+定论+数据明细+产物+manager 结论;codex 阶段复审整改+A-19)
    expect(second.envelope.managerConclusions).toEqual([
      '「小编」的结果摘要:账目已汇总',
      '「小编」的定论:门店销售总计 20370',
      '「小编」的数据明细(下游核对用,原件不可读):城中店 7850;东门店 6700;南山店 5820',
      `上游已验证产物(可读引用;能否写入以你的允许文件夹为准):${artifactPath}`,
      '小柊的交棒结论:以汇总数据为准写通报',
    ])
    expect(second.envelope.userRequest).toBe(firstRun.envelope.userRequest)
    // 同 graph+parent+依赖
    expect(second.graphId).toBe(firstRun.graphId)
    expect(second.dependsOnRunIds).toEqual([firstRun.runId])
    // handoff 边+input 落库(留档)
    const { edges } = await roles.getAgentRunGraph(firstRun.graphId)
    expect(edges).toContainEqual({ from: firstRun.runId, to: second.runId, kind: 'handoff' })
    const inputs = await roles.listUndeliveredAgentRunInputs(second.runId)
    expect(inputs.some((item) => item.kind === 'handoff')).toBe(true)
  })

  it('send_message 拒绝:来源未完成不能交棒', async () => {
    const first = orchestrator.spawn('manager-session', input())
    const firstApproval = await nextDelegationApproval()
    broker.resolve({ approvalId: firstApproval.request.id, decision: 'approve' })
    await first
    const running = (await roles.listAgentRuns()).find((run) => run.status === 'running')!
    await expect(
      orchestrator.sendMessage('manager-session', {
        sourceRunIds: [running.runId],
        targetRoleId: 'agent-a1b2c3d4e5f6',
        managerConclusion: '还没完成就想交',
        taskBrief: '不该到这',
        acceptanceCriteria: ['不该到这'],
        allowedWorkspacePaths: [workspace],
      }),
    ).rejects.toThrow('还没完成')
  })

  it('send_message 拒绝:来源跨协作链(初审测试空白补)', async () => {
    // 两条独立链各一条 completed run(不带 graphId 各自成链)
    const first = await roles.createAgentRun({
      runId: 'run-1111111111111111',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    const second = await roles.createAgentRun({
      runId: 'run-2222222222222222',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    expect(first.graphId).not.toBe(second.graphId)
    for (const runId of [first.runId, second.runId]) {
      await roles.transitionAgentRun(runId, { status: 'queued' })
      await roles.transitionAgentRun(runId, { status: 'running', internalSessionId: `internal-${runId}` })
      await roles.transitionAgentRun(runId, {
        status: 'completed',
        result: {
          summary: '完成',
          conclusions: ['定论'],
          artifactPaths: [],
          unmetCriteria: [],
          boundaryViolations: [],
        },
      })
    }
    await expect(
      orchestrator.sendMessage('manager-session', {
        sourceRunIds: [first.runId, second.runId],
        targetRoleId: 'agent-a1b2c3d4e5f6',
        managerConclusion: '跨链交',
        taskBrief: '不该到这',
        acceptanceCriteria: ['不该到这'],
        allowedWorkspacePaths: [workspace],
      }),
    ).rejects.toThrow('同一条协作链')
  })

  it('getDetail ownership:两个都合法的 manager 会话,run 只归其一(codex 整改复验)', async () => {
    await seedAwaitingLikeRun()
    // 第二个真实绑定的 manager 会话(合法,但 run 不归它)
    await roles.bindSession({
      sessionId: 'manager-session-b',
      roleId: SYSTEM_MANAGER_ROLE_ID,
      workspacePathSnapshot: dir,
      archivedAt: null,
      visibility: 'user',
      source: 'created',
      boundAt: 9,
    })
    await expect(query.getDetail('run-0000000000000009', 'manager-session-b')).rejects.toMatchObject({
      name: 'AgentRunOwnershipError',
    })
    // 归属会话正常取
    await expect(query.getDetail('run-0000000000000009', 'manager-session')).resolves.toMatchObject({
      run: { runId: 'run-0000000000000009' },
    })
  })

  it('打断 awaiting-approval run:未决派活确认卡立即收敛为拒绝,不挂到超时(codex 阶段复审整改)', async () => {
    // spawn 挂起等确认;此刻打断 awaiting run
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    expect(approval.request.kind).toBe('delegation')
    await expect(
      orchestrator.interruptAgent('manager-session', (approval.request as { runId: string }).runId),
    ).resolves.toMatchObject({ status: 'interrupted', interruptSource: 'manager' })
    // spawn 的确认 Promise 被 abortDelegationForRun 按 reject 收敛
    await expect(spawning).resolves.toMatchObject({ status: 'rejected' })
    // broker 不再有该 run 的未决卡
    expect(broker.hasPendingForSession('manager-session')).toBe(false)
  })

  it('interrupt_agent 对 queued 态 run 也生效(排队中直接收 interrupted,初审测试空白补)', async () => {
    await roles.createAgentRun({
      runId: 'run-0000000000000009',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    await roles.transitionAgentRun('run-0000000000000009', { status: 'queued' })
    await expect(
      orchestrator.interruptAgent('manager-session', 'run-0000000000000009'),
    ).resolves.toMatchObject({ status: 'interrupted', interruptSource: 'manager' })
    expect((await roles.getAgentRun('run-0000000000000009'))?.status).toBe('interrupted')
  })

  it('followup:干活中的 run 收到补充,同 internal 会话 steering 投递,计数+1 且推送(PLAN §6.5)', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns()).find((row) => row.status === 'running')!

    const outcome = await orchestrator.followupTask('manager-session', {
      runId: run.runId,
      message: '顺便把汇总表也核对一遍',
    })
    expect(outcome.followupCount).toBe(1)
    // 投递进同一个 internal 会话,内容带安全边界说明
    expect(runner.steered).toHaveLength(1)
    expect(runner.steered[0]!.sessionId).toBe(run.internalSessionId)
    expect(runner.steered[0]!.text).toContain('顺便把汇总表也核对一遍')
    expect(runner.steered[0]!.text).toContain('不改变你的允许文件夹')
    // followup_count 落库+input 留档
    expect((await roles.getAgentRun(run.runId))?.followupCount).toBe(1)
    const inputs = await roles.listUndeliveredAgentRunInputs(run.runId)
    expect(inputs.filter((item) => item.kind === 'followup')).toHaveLength(1)

    // 终态后拒绝追加
    runner.complete('<daweige-delegation-result version="1">\n{"summary":"完成","conclusions":[],"artifactPaths":[],"unmetCriteria":[]}\n</daweige-delegation-result>', run.internalSessionId!)
    await eventually(async () => (await roles.getAgentRun(run.runId))?.status === 'completed')
    await expect(
      orchestrator.followupTask('manager-session', { runId: run.runId, message: '结束了还想补' }),
    ).rejects.toThrow('已经结束')
  })

  it('followup 拒绝:排队中的 run 不投递(等开始后再补)', async () => {
    await roles.createAgentRun({
      runId: 'run-0000000000000009',
      managerSessionId: 'manager-session',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: input(),
    })
    await roles.transitionAgentRun('run-0000000000000009', { status: 'queued' })
    await expect(
      orchestrator.followupTask('manager-session', {
        runId: 'run-0000000000000009',
        message: '还没开始',
      }),
    ).rejects.toThrow('还没开始干活')
  })

  it('interrupt_agent:干活中的 run 收 interrupted(manager),abort 会话+拒未决卡,幂等重入(PLAN §6.6)', async () => {
    const spawning = orchestrator.spawn('manager-session', input())
    const approval = await nextDelegationApproval()
    broker.resolve({ approvalId: approval.request.id, decision: 'approve' })
    await spawning
    const run = (await roles.listAgentRuns()).find((row) => row.status === 'running')!

    const outcome = await orchestrator.interruptAgent('manager-session', run.runId)
    expect(outcome).toMatchObject({ runId: run.runId, status: 'interrupted', interruptSource: 'manager' })
    const interrupted = await roles.getAgentRun(run.runId)
    expect(interrupted?.status).toBe('interrupted')
    expect(interrupted?.interruptSource).toBe('manager')
    expect(interrupted?.failureMessage).toContain('总管打断')
    // 租约已同事务释放
    expect(await roles.findLeaseConflicts([workspace], 'run-none')).toEqual([])
    // 已终态:幂等返回
    await expect(orchestrator.interruptAgent('manager-session', run.runId)).resolves.toMatchObject({
      alreadyFinished: true,
    })
    // 别的 manager 会话不能打断
    await expect(orchestrator.interruptAgent('other-session', run.runId)).rejects.toThrow('不属于当前总管会话')
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


/** 直写 awaiting run(getDetail ownership 测试用,不经审批链)。 */
async function seedAwaitingLikeRun(): Promise<void> {
  await roles.createAgentRun({
    runId: 'run-0000000000000009',
    managerSessionId: 'manager-session',
    targetRoleId: 'agent-a1b2c3d4e5f6',
    targetRoleNameSnapshot: '小编',
    envelope: input(),
  })
}

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
