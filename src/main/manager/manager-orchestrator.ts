import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { DelegationEnvelope, AgentRunId, HandoffEnvelopeV1 } from '../../shared/domain/manager'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import { canonicalWorkspaceKey } from '../roles/role-files'
import type { ProviderSelection } from '../../shared/domain/provider'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { ApprovalBroker } from '../agent/approval-broker'
import { StrictDelegationPathPolicy } from '../files/path-policy'
import {
  AgentRunTransitionError,
  type AgentRunRow,
  type RoleRepository,
} from '../roles/role-repository'
import type { SessionService } from '../storage/session-service'
import type { WorkerRunner } from './worker-runner'
import type { AgentRunQueryService } from './agent-run-query-service'
import { AgentRunScheduler, type TryStartOutcome } from './agent-run-scheduler'

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'interrupted'])

export interface SpawnRoleAgentInput extends DelegationEnvelope {
  readonly targetRoleId: string
  /** 同链续派(首链 spawn 不传,服务端生成并在返回值里给出)。 */
  readonly graphId?: string
  /** 显式依赖(必须同 graph 同 manager;缺省空数组=可独立调度)。 */
  readonly dependsOnRunIds?: readonly string[]
}

/** send_message 入参(PLAN §6.3):userRequest 由服务端从 source 继承,模型不能改写原始需求。 */
export interface SendMessageInput {
  readonly sourceRunIds: readonly AgentRunId[]
  readonly targetRoleId: string
  readonly managerConclusion: string
  readonly taskBrief: string
  readonly acceptanceCriteria: readonly string[]
  readonly allowedWorkspacePaths: readonly string[]
}

/** followup_task 入参(PLAN §6.5):只接受同 manager 的 running/waiting run。 */
export interface FollowupTaskInput {
  readonly runId: AgentRunId
  readonly message: string
}

export interface ManagerOrchestratorDeps {
  readonly roles: RoleRepository
  readonly sessions: SessionService
  readonly approvals: ApprovalBroker
  readonly worker: WorkerRunner
  readonly query: AgentRunQueryService
  readonly userDataPath: string
  readonly selection: (roleId: string) => Promise<ProviderSelection>
  readonly emitEvent: (event: AgentPushEvent) => void
  readonly isPackaged: boolean
}

/** manager 协作工具箱的服务端权威实现；模型参数从不直接成为授权事实。 */
export class ManagerOrchestrator {
  private accepting = true
  private readonly active = new Map<AgentRunId, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly scheduler: AgentRunScheduler

  constructor(private readonly deps: ManagerOrchestratorDeps) {
    this.scheduler = new AgentRunScheduler({
      roles: deps.roles,
      tryStart: (run) => this.tryStartQueued(run),
      onCascadeFailed: (run) => this.emit(run),
    })
  }

  toolsForSession(managerSessionId: string): AgentTool[] {
    return [
      {
        name: 'spawn_role_agent',
        label: '派出角色',
        description: '构造完整派活信封，经用户确认后派出一个 worker；同链续派带 graphId，有先后顺序的带 dependsOnRunIds。',
        parameters: SpawnParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => this.toolResult(await this.track(this.spawn(managerSessionId, params as SpawnRoleAgentInput))),
      },
      {
        name: 'send_message',
        label: '交棒定论',
        description: '把已完成的派活定论交给下一个角色(经用户确认);只传定论与数据明细,不传思考过程。',
        parameters: SendMessageParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => this.toolResult(await this.track(this.sendMessage(managerSessionId, params as SendMessageInput))),
      },
      {
        name: 'wait_agents',
        label: '等待派活',
        description: '等待当前总管会话拥有的一到八个派活，返回逐个稳定快照。',
        parameters: WaitParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => {
          const input = params as { runIds: string[]; timeoutMs?: number }
          return this.toolResult(await this.track(this.wait(managerSessionId, input.runIds, input.timeoutMs)))
        },
      },
      {
        name: 'list_agents',
        label: '查看派活',
        description: '列出当前总管会话的派活摘要；带 graphId 时只看那条协作链。',
        parameters: ListParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => {
          const input = params as { graphId?: string }
          return this.toolResult(await this.track(this.list(managerSessionId, input.graphId)))
        },
      },
      {
        name: 'followup_task',
        label: '补充要求',
        description: '给干活中(running/waiting)的派活追加一句补充指令;不改变允许文件夹,已结束的派活要重新派。',
        parameters: FollowupParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => this.toolResult(await this.track(this.followupTask(managerSessionId, params as FollowupTaskInput))),
      },
      {
        name: 'interrupt_agent',
        label: '打断派活',
        description: '中止干活中的派活;已完成的产出保留,未完成的不再继续。',
        parameters: InterruptParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => this.toolResult(await this.track(this.interruptAgent(managerSessionId, (params as FollowupTaskInput).runId))),
      },
    ]
  }

  async spawn(managerSessionId: string, input: SpawnRoleAgentInput): Promise<{
    runId: AgentRunId
    graphId: string
    status: 'running' | 'queued' | 'rejected' | 'failed'
    targetRoleName: string
    /** queued 时给排队原因人话(工作区被占/依赖未完成/并发满)。 */
    message?: string
  }> {
    if (!this.accepting) throw new Error('应用正在退出，不能再派出新任务')
    const { role, envelope } = await this.validateSpawn(managerSessionId, input)
    const runId = this.newRunId()
    const run = await this.deps.roles.createAgentRun({
      runId,
      managerSessionId,
      targetRoleId: role.id,
      targetRoleNameSnapshot: role.displayName,
      envelope,
      ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
      ...(input.dependsOnRunIds !== undefined ? { dependsOnRunIds: input.dependsOnRunIds } : {}),
    })
    await this.emit(run)
    return this.requestApprovalAndExecute(run, envelope)
  }

  /** 仅供 E2E 启动夹具：把直写库的 awaiting run 接回真实确认与执行链。 */
  resumeAwaitingRunForE2E(runId: AgentRunId): Promise<void> {
    return this.track(this.resumeAwaitingRunForE2ETracked(runId))
  }

  /**
   * 中转交棒(PLAN §6.3):只有 manager 工具箱注册;子角色互不直连。
   * 服务端从 DB 权威 DelegationResult 构造 HandoffEnvelopeV1(不读 child thinking),
   * 交棒定论烘进下游 envelope 的 managerConclusions(只继承定论),handoff 全文另落 inputs 留档。
   */
  async sendMessage(managerSessionId: string, input: SendMessageInput): Promise<{
    runId: AgentRunId
    graphId: string
    status: 'running' | 'queued' | 'rejected' | 'failed'
    targetRoleName: string
    message?: string
  }> {
    if (!this.accepting) throw new Error('应用正在退出，不能再派出新任务')
    if (input.sourceRunIds.length < 1 || input.sourceRunIds.length > 8) {
      throw new Error('交棒来源需为 1~8 个已完成派活')
    }
    // 1. source 校验:同 manager、同 graph、全部 completed;按 (createdAt, runId) 稳定排序
    const sourceRows: AgentRunRow[] = []
    const graphId = await this.resolveHandoffGraph(managerSessionId, input.sourceRunIds, sourceRows)
    const sorted = [...sourceRows].sort((a, b) =>
      a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : (a.runId < b.runId ? -1 : 1),
    )
    // 2. DB 权威定论 → HandoffEnvelopeV1(模型不能自报 artifact/result)
    const handoff = this.buildHandoffEnvelope(sorted, input.managerConclusion)
    // 3. 下游 envelope:DB 权威事实全集烘进 managerConclusions(codex 阶段复审整改:
    // 上游保守 fallback 时 conclusions=[] 只有 summary,漏了它下游什么都看不到)。
    // summary/unmet/boundary 均来自主进程权威记录;thinking/transcript 仍无数据入口。
    // 单条事实截断到 1_900(前缀+正文仍低于 envelope 单条 2_000 上限):上游 summary 合法
    // 长度可达 20_000 字,硬拒会让"较长但合法的交棒"整体失败(codex 整改复验)
    const clipFact = (text: string): string =>
      [...text].length <= 1_900 ? text : `${[...text].slice(0, 1_890).join('')}(已截断)`
    const sourceSummaries = sorted
      .filter((row) => row.result?.summary)
      .map((row) => clipFact(`「${row.targetRoleNameSnapshot}」的结果摘要:${row.result!.summary}`))
    const unmetFacts = handoff.unmetCriteria.length > 0
      ? [clipFact(`上游未满足的验收(做下游任务时要留意):${handoff.unmetCriteria.join('；')}`)]
      : []
    const boundaryNotice = handoff.boundaryFacts.length > 0
      ? [clipFact(`上游执行期的越界事实(主进程权威记录,仅供参考):${handoff.boundaryFacts.join('；')}`)]
      : []
    // A-19:上游数据明细随定论传给下游,免去下游想读原件核对的冲动(原件读取仍被边界拦)。
    // 独立复审 整改:合并为单条(与 unmet/boundary 同构)——分条时 8 来源×2+固定 4 条
    // 必然撞 20 条上限,常态交棒会整体报错;合并只牺牲极端场景的部分明细长度(clipFact 截断有标注)。
    const detailFacts = handoff.detailData.length > 0
      ? [clipFact(handoff.detailData.join('；'))]
      : []
    const conclusions = [
      ...sourceSummaries,
      ...handoff.conclusions.map(clipFact),
      ...detailFacts,
      ...(handoff.artifactPaths.length > 0
        ? [clipFact(`上游已验证产物(可读引用;能否写入以你的允许文件夹为准):${handoff.artifactPaths.join('；')}`)]
        : []),
      ...unmetFacts,
      ...boundaryNotice,
      `小柊的交棒结论:${input.managerConclusion}`,
    ]
    if (conclusions.length > 20) {
      throw new Error('这条交棒的定论条数超过 20(瓶颈常是上游结论太多):请减少交棒来源、精简上游结论条数,或分批交棒')
    }
    // 拼接后的单条长度校验(初审建议:上游 2000 字定论加「角色」前缀、4000 字 manager 结论
    // 都可能溢出 envelope 上限;报错定位到具体条目,模型可据此纠正)
    for (const item of conclusions) {
      if ([...item].length > 2_000) {
        throw new Error(`这条定论太长(开头是「${item.slice(0, 24)}…」):交棒结论每条最多 2000 字,请缩短来源定论或你的交棒结论后重试`)
      }
    }
    const { role, envelope } = await this.validateSpawn(managerSessionId, {
      targetRoleId: input.targetRoleId,
      userRequest: sorted[0]!.envelope.userRequest,
      managerConclusions: conclusions,
      taskBrief: input.taskBrief,
      acceptanceCriteria: input.acceptanceCriteria,
      allowedWorkspacePaths: input.allowedWorkspacePaths,
    })
    // 4. 下游 run(同 graph+parent=首个 source+依赖全部 source)+handoff input/边落库
    const runId = this.newRunId()
    const run = await this.deps.roles.createAgentRun({
      runId,
      managerSessionId,
      targetRoleId: role.id,
      targetRoleNameSnapshot: role.displayName,
      envelope,
      graphId,
      parentRunId: sorted[0]!.runId,
      dependsOnRunIds: sorted.map((row) => row.runId),
    })
    await this.deps.roles.appendAgentRunHandoff({
      targetRunId: runId,
      sourceRunIds: sorted.map((row) => row.runId),
      payload: handoff,
    })
    await this.emit(run)
    // 5. 新 delegation 卡照弹;批准后调度器才可能启动(交棒 artifact 只是引用,不自动获得源目录写权限)
    return this.requestApprovalAndExecute(run, envelope)
  }

  /** 交棒来源校验:全部同 manager、同 graph、completed;结果按入参顺序推入 out。 */
  private async resolveHandoffGraph(
    managerSessionId: string,
    sourceRunIds: readonly AgentRunId[],
    out: AgentRunRow[],
  ): Promise<string> {
    let graphId: string | undefined
    for (const runId of sourceRunIds) {
      const row = await this.deps.roles.getAgentRun(runId)
      if (!row || row.managerSessionId !== managerSessionId) {
        throw new Error('交棒来源派活不存在，或不属于当前总管会话')
      }
      if (row.status !== 'completed') {
        throw new Error(`交棒来源「${row.targetRoleNameSnapshot}」还没完成,只能交棒已完成的定论`)
      }
      if (graphId === undefined) graphId = row.graphId
      else if (row.graphId !== graphId) throw new Error('交棒来源必须在同一条协作链上')
      out.push(row)
    }
    return graphId!
  }

  /** 从 DB 权威 result/boundary 记录构造定论信封(PLAN §6.3:不读 thinking,不复制 transcript)。 */
  private buildHandoffEnvelope(sources: readonly AgentRunRow[], managerConclusion: string): HandoffEnvelopeV1 {
    const conclusions: string[] = []
    const artifactPaths: string[] = []
    const unmetCriteria: string[] = []
    const boundaryFacts: string[] = []
    const detailData: string[] = []
    for (const row of sources) {
      const result = row.result
      if (!result) throw new Error(`交棒来源缺少定论记录:${row.runId}`)
      conclusions.push(...result.conclusions.map((item) => `「${row.targetRoleNameSnapshot}」的定论:${item}`))
      artifactPaths.push(...result.artifactPaths)
      unmetCriteria.push(...result.unmetCriteria.map((item) => `「${row.targetRoleNameSnapshot}」未满足:${item}`))
      if (result.detailData !== undefined) {
        detailData.push(`「${row.targetRoleNameSnapshot}」的数据明细(下游核对用,原件不可读):${result.detailData}`)
      }
      for (const violation of row.boundaryViolations) {
        boundaryFacts.push(`${violation.operation === 'write' ? '写' : '读'} ${violation.path}:${violation.reason}`)
      }
    }
    return {
      schemaVersion: 1,
      sourceRunIds: sources.map((row) => row.runId),
      conclusions,
      artifactPaths,
      unmetCriteria,
      boundaryFacts,
      detailData,
      managerConclusion,
    }
  }

  private async resumeAwaitingRunForE2ETracked(runId: AgentRunId): Promise<void> {
    if (this.deps.isPackaged || !process.env.DAWEIGE_E2E_SCENARIO) {
      throw new Error('E2E 派活夹具只能在未打包且已声明测试场景时使用')
    }
    const run = await this.deps.roles.getAgentRun(runId)
    if (!run || run.status !== 'awaiting-approval') {
      throw new Error(`E2E 派活夹具不是待确认状态:${runId}`)
    }
    await this.emit(run)
    await this.requestApprovalAndExecute(run, run.envelope)
  }

  private async requestApprovalAndExecute(
    initialRun: AgentRunRow,
    envelope: DelegationEnvelope,
  ): Promise<{ runId: AgentRunId; graphId: string; status: 'running' | 'queued' | 'rejected' | 'failed'; targetRoleName: string; message?: string }> {
    let run = initialRun
    const runId = run.runId
    const outcome = await this.deps.approvals.requestDelegation({
      sessionId: run.managerSessionId,
      runId,
      targetRoleId: run.targetRoleId,
      targetRoleName: run.targetRoleNameSnapshot,
      taskBrief: envelope.taskBrief,
      allowedWorkspacePaths: envelope.allowedWorkspacePaths,
      acceptanceCriteria: envelope.acceptanceCriteria,
      title: `派给${run.targetRoleNameSnapshot}：${envelope.taskBrief.slice(0, 60)}`,
      description: `允许操作：${envelope.allowedWorkspacePaths.join('；')}。验收：${envelope.acceptanceCriteria.join('；')}`,
    })
    if (outcome.decision === 'reject') {
      try {
        run = await this.deps.roles.transitionAgentRun(runId, {
          status: 'rejected',
          failureMessage: outcome.timedOut ? '等待派活确认超时，本次未派出' : (outcome.note ?? '用户选择不派出'),
        })
      } catch (error) {
        if (isInvalidatedRunError(error)) return invalidatedSpawnResult(initialRun)
        throw error
      }
      await this.emit(run)
      // rejected 也是终态非 completed:依赖它的排队派活要级联收尾(backend 专审整改)
      void this.scheduler.tick()
      return { runId, graphId: run.graphId, status: 'rejected', targetRoleName: run.targetRoleNameSnapshot }
    }

    try {
      run = await this.deps.roles.transitionAgentRun(runId, { status: 'queued' })
    } catch (error) {
      if (isInvalidatedRunError(error)) return invalidatedSpawnResult(initialRun)
      throw error
    }
    await this.emit(run)
    // 统一走调度器启动(PLAN §6.2):按 createdAt 公平排队,依赖/并发/根互斥在 tick 内裁决
    await this.scheduler.tick()
    const after = await this.deps.roles.getAgentRun(runId)
    if (!after) throw new Error(`派活不存在:${runId}`)
    run = after
    await this.emit(run)
    if (run.status === 'running') {
      return { runId, graphId: run.graphId, status: 'running', targetRoleName: run.targetRoleNameSnapshot }
    }
    // 排队/终态如实区分(backend 专审整改:启动失败或被级联收 failed 的 run 不再并成 rejected)
    if (run.status === 'queued') {
      return {
        runId,
        graphId: run.graphId,
        status: 'queued',
        targetRoleName: run.targetRoleNameSnapshot,
        message: queueReasonText(run.queueReason),
      }
    }
    return {
      runId,
      graphId: run.graphId,
      status: run.status === 'rejected' ? 'rejected' : 'failed',
      targetRoleName: run.targetRoleNameSnapshot,
      message: run.failureMessage ?? '这条派活没有启动成功',
    }
  }

  /**
   * 调度器回调:原子启动一个 queued run——建 internal session →
   * acquireLeasesAndStart(资格+根互斥+写租约+转 running 同事务)→ 后台 executeWorker。
   * 永不抛错:意外失败把 run 收 failed 后返回 gone,不让单点故障打断整轮调度。
   */
  private async tryStartQueued(run: AgentRunRow): Promise<TryStartOutcome> {
    const runId = run.runId
    const envelope = run.envelope
    if (!this.accepting) return 'gone'
    let internalSessionId: string | undefined
    try {
      const selection = await this.deps.selection(run.targetRoleId)
      const detail = await this.deps.sessions.createInternalSession({
        roleId: run.targetRoleId,
        workspacePath: envelope.allowedWorkspacePaths[0]!,
        providerId: selection.providerId,
        modelId: selection.modelId,
      })
      internalSessionId = detail.summary.id
      const roots: string[] = []
      for (const p of envelope.allowedWorkspacePaths) {
        roots.push(await canonicalWorkspaceKey(p).catch(() => p))
      }
      const leaseConflict = await this.deps.roles.acquireLeasesAndStart({
        runId,
        internalSessionId,
        canonicalRoots: roots,
      })
      if (leaseConflict !== null) {
        // 冲突:原语已留 queued+queueReason=workspace-lock;internal 会话先清掉,真正启动时再建
        await this.deps.sessions.remove(internalSessionId).catch(() => {})
        const queuedRun = await this.deps.roles.getAgentRun(runId)
        if (queuedRun) await this.emit(queuedRun)
        return 'lease-conflict'
      }
      const startedRun = await this.deps.roles.getAgentRun(runId)
      if (!startedRun) throw new Error(`派活不存在:${runId}`)
      await this.emit(startedRun)
      const task = this.executeWorker(runId, internalSessionId, selection, envelope)
      this.active.set(runId, task)
      void task.then(
        () => this.active.delete(runId),
        () => this.active.delete(runId),
      )
      return 'started'
    } catch (error) {
      if (internalSessionId) await this.deps.sessions.remove(internalSessionId).catch(() => {})
      if (error instanceof AgentRunTransitionError) return 'gone' // 竞争者已处理
      console.error('[manager] 调度启动失败,该派活收 failed:', error instanceof Error ? error.message : error)
      try {
        const current = await this.deps.roles.getAgentRun(runId)
        if (current && !TERMINAL.has(current.status)) {
          const failed = await this.deps.roles.transitionAgentRun(runId, {
            status: 'failed',
            failureMessage: '内部任务会话创建失败，本次没有执行',
          })
          await this.emit(failed)
        }
      } catch {
        // 收尾失败说明状态已被并发处理,不再追
      }
      return 'gone'
    }
  }

  async wait(managerSessionId: string, runIds: readonly AgentRunId[], timeoutMs = 30_000): Promise<unknown> {
    const timeout = Math.max(10_000, Math.min(300_000, Math.trunc(timeoutMs)))
    const seen = new Set<AgentRunId>()
    for (const runId of runIds) {
      const run = await this.ownedRun(managerSessionId, runId)
      seen.add(run.runId)
      if (TERMINAL.has(run.status)) continue
      // 已在 waiting 的保持原原因:等用户处理确认卡(user-approval)不被 manager-wait 覆盖,
      // 卡片"小柊在等/等你处理"的显示不失真(初审建议)
      if (run.status === 'waiting') continue
      try {
        const waiting = await this.deps.roles.transitionAgentRun(runId, {
          status: 'waiting',
          waitingReason: 'manager-wait',
        })
        await this.emit(waiting)
      } catch (error) {
        if (!(error instanceof AgentRunTransitionError)) throw error
        // queued→waiting 非法:排队中的 run 保持 queued,由 active 等待与最终重读收敛
      }
    }
    const tasks = [...seen]
      .map((runId) => this.active.get(runId))
      .filter((task): task is Promise<void> => task !== undefined)
    if (tasks.length > 0) await this.waitWithTimeout(tasks, timeout)
    const finals: AgentRunRow[] = []
    for (const runId of seen) finals.push(await this.ownedRun(managerSessionId, runId))
    const summaries = await Promise.all(finals.map((run) => this.deps.query.summary(run)))
    const timedOut = finals.some((run) => !TERMINAL.has(run.status))
    // PLAN §2.3:逐 run 稳定快照(按传入顺序),一个完成不连坐其他 run
    return {
      timedOut,
      runs: runIds.filter((id) => seen.has(id)).map((id) => {
        const index = finals.findIndex((run) => run.runId === id)
        const run = finals[index]!
        const summary = summaries[index]!
        return TERMINAL.has(run.status)
          ? {
              runId: id,
              status: run.status,
              queueReason: run.queueReason,
              result: run.result,
              usage: summary.usage,
              violations: run.boundaryViolations,
            }
          : {
              runId: id,
              status: run.status,
              queueReason: run.queueReason,
              usage: summary.usage,
            }
      }),
    }
  }

  async list(managerSessionId: string, graphId?: string): Promise<unknown> {
    const runs = await this.deps.query.list(managerSessionId)
    return graphId === undefined ? runs : runs.filter((run) => run.graphId === graphId)
  }

  /**
   * followup 追加(PLAN §6.5):只接受同 manager 的 running/waiting run;不建新 run。
   * 事务插 input+计数(appendAgentRunFollowup)→ 持久化补充消息到 internal pi 会话 →
   * pi steering 队列在 turn 边界注入;同一个 run() promise 覆盖后续轮次。
   */
  async followupTask(managerSessionId: string, input: FollowupTaskInput): Promise<{
    runId: AgentRunId
    followupCount: number
    message: string
  }> {
    const length = [...input.message].length
    if (length < 1 || length > 4_000) throw new Error('补充要求需为 1~4000 字')
    const run = await this.ownedRun(managerSessionId, input.runId)
    if (TERMINAL.has(run.status)) {
      throw new Error('这条派活已经结束,补充要求送不进去了;请让小柊重新派活')
    }
    if (run.status !== 'running' && run.status !== 'waiting') {
      throw new Error(`这条派活还没开始干活(当前:${queueReasonText(run.queueReason) || '排队中'}),等它开始后再补充`)
    }
    if (!run.internalSessionId) throw new Error('这条派活还没有内部会话,补充要求送不进去')
    // 1. 先投递再落库(初审建议:落库+计数成功但 run 恰好终态时,steer 消息永远无人消费,
    //    "已送达"就成了错话)。投递前置:steer 成功=消息确已进 pi 会话;随后的落库若被
    //    终态拒绝,如实报"刚好结束",消息留在 transcript 无害。
    await this.deps.worker.steerSession(run.internalSessionId, renderFollowupInstruction(input.message))
    let followupCount: number
    try {
      followupCount = await this.deps.roles.appendAgentRunFollowup({
        runId: run.runId,
        payload: {
          kind: 'followup',
          message: input.message,
          notice: '补充要求不得扩大允许操作的文件夹;如需新路径,让小柊重新派活',
          sentAt: Date.now(),
        },
      })
    } catch {
      throw new Error('这条派活刚好结束了,补充要求没有生效;请让小柊重新派活')
    }
    // 3. 推送(followupCount 已变,卡片要跟着显示);返回前重读状态——
    // 投递与落库都成功但 run 恰在此间收终态时不宣称"已送达"(codex 整改复验:
    // 三联组合"计数+1+消息无人消费+宣称成功"必须不可能;如实告知让小柊重新安排)
    const updated = await this.deps.roles.getAgentRun(run.runId)
    if (updated) await this.emit(updated)
    if (!updated || TERMINAL.has(updated.status)) {
      return {
        runId: run.runId,
        followupCount,
        message: '补充要求已写入,但这条派活刚好结束了,它可能看不到;需要的话请重新派活',
      }
    }
    return { runId: run.runId, followupCount, message: '补充要求已送达,它会在当前步骤结束后看到' }
  }

  /**
   * manager 工具 interrupt_agent(PLAN §6.6):与受控 IPC 同一收尾链——
   * 先 DB CAS 落 interrupted(manager),再 abort 运行时+未决卡,最后触发调度。
   */
  async interruptAgent(managerSessionId: string, runId: AgentRunId): Promise<unknown> {
    const run = await this.ownedRun(managerSessionId, runId)
    if (TERMINAL.has(run.status)) {
      return { runId, status: run.status, alreadyFinished: true }
    }
    let interrupted: AgentRunRow
    try {
      interrupted = await this.deps.roles.transitionAgentRun(runId, {
        status: 'interrupted',
        failureMessage: '总管打断了这条派活;已完成的产出保留,未完成的没有继续',
        interruptSource: 'manager',
      })
    } catch {
      // 并发竞态(interrupt IPC/用户先到):幂等返回最新状态
      const latest = await this.deps.roles.getAgentRun(runId)
      if (latest && TERMINAL.has(latest.status)) {
        return { runId, status: latest.status, alreadyFinished: true }
      }
      throw new Error('这条派活刚被别人处理,请刷新再看')
    }
    if (interrupted.internalSessionId) {
      this.deps.worker.abortSession(interrupted.internalSessionId)
      this.deps.approvals.abortAllForSession(
        interrupted.internalSessionId,
        '派活被打断，本次未执行',
      )
    } else {
      // awaiting 阶段:精确拒绝该 run 的未决派活卡,spawn 调用立即收敛(codex 阶段复审整改)
      this.deps.approvals.abortDelegationForRun(runId, '派活被打断，本次未派出')
    }
    await this.emit(interrupted)
    this.notifySchedule()
    return { runId, status: 'interrupted', interruptSource: 'manager' }
  }

  /** 受控 IPC(interrupt)释放并发槽/租约后触发一轮调度(排队者可能可以启动)。 */
  notifySchedule(): void {
    void this.scheduler.tick()
  }

  /** child 确认卡在 ApprovalGate 挂起/收尾时调用。 */
  async markChildApproval(internalSessionId: string, waiting: boolean): Promise<void> {
    const run = await this.deps.roles.getAgentRunByInternalSession(internalSessionId)
    if (!run || TERMINAL.has(run.status)) return
    const next = await this.deps.roles.transitionAgentRun(run.runId, waiting
      ? { status: 'waiting', waitingReason: 'user-approval' }
      : { status: 'running' })
    await this.emit(next)
  }

  async noteBoundaryViolation(internalSessionId: string): Promise<void> {
    const run = await this.deps.roles.getAgentRunByInternalSession(internalSessionId)
    if (run) await this.emit((await this.deps.roles.getAgentRun(run.runId)) ?? run)
  }

  stopAccepting(): void {
    this.accepting = false
    this.scheduler.dispose()
    this.deps.worker.stopAccepting()
  }

  async drain(): Promise<void> {
    // operation 收尾过程中仍可能登记 active worker；循环到两个集合都排空，
    // 避免只等待一次快照后就提前关闭底层库。
    while (this.operations.size > 0 || this.active.size > 0) {
      await Promise.allSettled([...this.operations, ...this.active.values()])
    }
  }

  private async executeWorker(
    runId: string,
    sessionId: string,
    selection: ProviderSelection,
    envelope: DelegationEnvelope,
  ): Promise<void> {
    const policy = new StrictDelegationPathPolicy(envelope.allowedWorkspacePaths, this.deps.userDataPath)
    try {
      const output = await this.deps.worker.run({
        sessionId,
        selection,
        envelope,
        policy,
        loadBoundaryViolations: async () => ((await this.deps.roles.getAgentRun(runId))?.boundaryViolations ?? []).map((item) => ({
          ...item,
          toolName: item.toolName ?? 'unknown',
        })),
      })
      const current = await this.deps.roles.getAgentRun(runId)
      if (!current || TERMINAL.has(current.status)) return
      const next = output.turn.status === 'completed' && output.result
        ? await this.deps.roles.transitionAgentRun(runId, { status: 'completed', result: output.result })
        : await this.deps.roles.transitionAgentRun(runId, {
            status: 'failed',
            failureMessage: output.turn.errorMessage ?? (output.turn.status === 'aborted' ? '内部任务已中止' : '内部任务执行失败'),
          })
      await this.emit(next)
    } catch (error) {
      const current = await this.deps.roles.getAgentRun(runId)
      if (!current || TERMINAL.has(current.status)) return
      const failed = await this.deps.roles.transitionAgentRun(runId, {
        status: 'failed',
        failureMessage: error instanceof Error ? error.message : '内部任务执行失败',
      })
      await this.emit(failed)
    } finally {
      // 终态(含被打断)空出并发槽/租约:排队者可能可以启动;tick 幂等合并,不阻塞收尾
      void this.scheduler.tick()
    }
  }

  private async validateSpawn(managerSessionId: string, input: SpawnRoleAgentInput) {
    const caller = await this.deps.roles.getBinding(managerSessionId)
    if (caller?.roleId !== SYSTEM_MANAGER_ROLE_ID || caller.visibility !== 'user') {
      throw new Error('只有小柊的用户会话可以派活')
    }
    if (!/^agent-[0-9a-f]{12}$/.test(input.targetRoleId)) throw new Error('目标角色 ID 不合法')
    const role = await this.deps.roles.getRoleRow(input.targetRoleId)
    if (!role || role.kind !== 'worker' || role.lifecycle !== 'ready' || role.archivedAt !== null) {
      throw new Error('目标角色不可用，请选择未归档且状态正常的 worker')
    }
    this.validateEnvelope(input)
    const mounts = (await this.deps.roles.listMountRows()).filter((mount) => mount.roleId === role.id)
    const byKey = new Map(mounts.map((mount) => [mount.canonicalKey, mount]))
    const realPaths: string[] = []
    for (const path of input.allowedWorkspacePaths) {
      const key = await canonicalWorkspaceKey(path).catch(() => { throw new Error(`允许路径不存在：${path}`) })
      const mount = byKey.get(key)
      if (!mount) throw new Error(`允许路径不是目标角色的挂载文件夹：${path}`)
      if (mount.availability !== 'available') throw new Error(`目标角色的挂载文件夹当前不可用：${path}`)
      const info = await stat(mount.workspacePath).catch(() => undefined)
      if (!info?.isDirectory()) throw new Error(`目标角色的挂载文件夹当前不存在：${path}`)
      realPaths.push(await realpath(mount.workspacePath))
    }
    return {
      role,
      envelope: {
        userRequest: input.userRequest,
        managerConclusions: [...input.managerConclusions],
        taskBrief: input.taskBrief,
        acceptanceCriteria: [...input.acceptanceCriteria],
        allowedWorkspacePaths: realPaths,
      } satisfies DelegationEnvelope,
    }
  }

  private validateEnvelope(input: SpawnRoleAgentInput): void {
    const valid = (value: string, min: number, max: number) => [...value].length >= min && [...value].length <= max
    if (!valid(input.userRequest, 1, 100_000)) throw new Error('用户原始需求长度不合法')
    if (!valid(input.taskBrief, 1, 4_000)) throw new Error('任务简报需为 1~4000 字')
    if (input.managerConclusions.length > 20 || input.managerConclusions.some((item) => !valid(item, 1, 2_000))) throw new Error('总管定论数量或长度不合法')
    if (input.acceptanceCriteria.length < 1 || input.acceptanceCriteria.length > 20 || input.acceptanceCriteria.some((item) => !valid(item, 1, 1_000))) throw new Error('验收要点数量或长度不合法')
    if (input.allowedWorkspacePaths.length < 1 || input.allowedWorkspacePaths.length > 8) throw new Error('允许路径需为 1~8 个挂载文件夹')
  }

  private async ownedRun(managerSessionId: string, runId: string): Promise<AgentRunRow> {
    const run = await this.deps.roles.getAgentRun(runId)
    if (!run || run.managerSessionId !== managerSessionId) throw new Error('派活记录不存在，或不属于当前总管会话')
    return run
  }

  private async emit(row: AgentRunRow): Promise<void> {
    this.deps.emitEvent({
      type: 'agent_run_updated',
      managerSessionId: row.managerSessionId,
      run: await this.deps.query.summary(row),
    })
  }

  private toolResult(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }
  }

  private newRunId(): AgentRunId {
    return `run-${randomBytes(8).toString('hex')}`
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    )
    return operation
  }

  private waitWithTimeout(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      void Promise.allSettled(tasks).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

const EnvelopeFields = {
  userRequest: Type.String({ minLength: 1, maxLength: 100_000 }),
  managerConclusions: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 20 }),
  taskBrief: Type.String({ minLength: 1, maxLength: 4_000 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 }),
  allowedWorkspacePaths: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 8 }),
} as const
const SpawnParams = Type.Object({
  targetRoleId: Type.String({ pattern: '^agent-[0-9a-f]{12}$' }),
  graphId: Type.Optional(Type.String({ pattern: '^graph-[a-f0-9]{16}$' })),
  dependsOnRunIds: Type.Optional(
    Type.Array(Type.String({ pattern: '^run-[0-9a-f]{16}$' }), { maxItems: 8 }),
  ),
  ...EnvelopeFields,
}, { additionalProperties: false })
const WaitParams = Type.Object({
  runIds: Type.Array(Type.String({ pattern: '^run-[0-9a-f]{16}$' }), { minItems: 1, maxItems: 8 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 300_000 })),
}, { additionalProperties: false })
const SendMessageParams = Type.Object({
  sourceRunIds: Type.Array(Type.String({ pattern: '^run-[0-9a-f]{16}$' }), { minItems: 1, maxItems: 8 }),
  targetRoleId: Type.String({ pattern: '^agent-[0-9a-f]{12}$' }),
  // 上限 1900:拼上「小柊的交棒结论:」前缀后仍低于 envelope 单条 2000 字上限
  managerConclusion: Type.String({ minLength: 1, maxLength: 1_900 }),
  taskBrief: Type.String({ minLength: 1, maxLength: 4_000 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 20 }),
  allowedWorkspacePaths: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false })
const ListParams = Type.Object({
  graphId: Type.Optional(Type.String({ pattern: '^graph-[a-f0-9]{16}$' })),
}, { additionalProperties: false })
const FollowupParams = Type.Object({
  runId: Type.String({ pattern: '^run-[0-9a-f]{16}$' }),
  message: Type.String({ minLength: 1, maxLength: 4_000 }),
}, { additionalProperties: false })
const InterruptParams = Type.Object({
  runId: Type.String({ pattern: '^run-[0-9a-f]{16}$' }),
}, { additionalProperties: false })

/** followup 投递文本:安全边界写明,补充不扩权。 */
function renderFollowupInstruction(message: string): string {
  return [
    '【用户补充要求(干活中追加)】',
    message,
    '(这条补充不改变你的允许文件夹范围与任务验收;如果确实需要新路径或改任务边界,说明原因并停下,由小柊重新安排。)',
  ].join('\n')
}

const INVALIDATED_SPAWN_MESSAGE = '这次派活已失效(角色刚被删除或归档),请告知用户'

function isInvalidatedRunError(error: unknown): boolean {
  return error instanceof AgentRunTransitionError
    || (error instanceof Error && error.message.startsWith('派活不存在:'))
}

function queueReasonText(reason: AgentRunRow['queueReason']): string {
  switch (reason) {
    case 'workspace-lock':
      return '这条派活先排队:文件夹正被另一条派活使用,腾出来就自动开始'
    case 'dependency':
      return '这条派活在等上游完成,上游跑完就自动开始'
    case 'concurrency-limit':
      return '同时干活的派活已满 3 条,有空位就自动开始'
    default:
      return '这条派活已排队,条件满足就自动开始'
  }
}

function invalidatedSpawnResult(run: AgentRunRow): {
  runId: AgentRunId
  graphId: string
  status: 'rejected'
  targetRoleName: string
  error: string
} {
  return {
    runId: run.runId,
    graphId: run.graphId,
    status: 'rejected',
    targetRoleName: run.targetRoleNameSnapshot,
    error: INVALIDATED_SPAWN_MESSAGE,
  }
}
