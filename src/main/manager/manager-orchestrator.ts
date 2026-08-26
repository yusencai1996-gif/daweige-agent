import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { DelegationEnvelope, AgentRunId } from '../../shared/domain/manager'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import type { ProviderSelection } from '../../shared/domain/provider'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { ApprovalBroker } from '../agent/approval-broker'
import { StrictDelegationPathPolicy } from '../files/path-policy'
import { canonicalWorkspaceKey } from '../roles/role-files'
import {
  AgentRunSlotOccupiedError,
  AgentRunTransitionError,
  type AgentRunRow,
  type RoleRepository,
} from '../roles/role-repository'
import type { SessionService } from '../storage/session-service'
import type { WorkerRunner } from './worker-runner'
import type { AgentRunQueryService } from './agent-run-query-service'

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'interrupted'])

export interface SpawnRoleAgentInput extends DelegationEnvelope {
  readonly targetRoleId: string
}

export interface ManagerOrchestratorDeps {
  readonly roles: RoleRepository
  readonly sessions: SessionService
  readonly approvals: ApprovalBroker
  readonly worker: WorkerRunner
  readonly query: AgentRunQueryService
  readonly userDataPath: string
  readonly selection: () => Promise<ProviderSelection>
  readonly emitEvent: (event: AgentPushEvent) => void
  readonly isPackaged: boolean
}

/** manager 三工具的服务端权威实现；模型参数从不直接成为授权事实。 */
export class ManagerOrchestrator {
  private accepting = true
  private readonly active = new Map<AgentRunId, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()

  constructor(private readonly deps: ManagerOrchestratorDeps) {}

  toolsForSession(managerSessionId: string): AgentTool[] {
    return [
      {
        name: 'spawn_role_agent',
        label: '派出角色',
        description: '构造完整派活信封，经用户确认后派出一个 worker。',
        parameters: SpawnParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => this.toolResult(await this.track(this.spawn(managerSessionId, params as SpawnRoleAgentInput))),
      },
      {
        name: 'wait_agents',
        label: '等待派活',
        description: '等待当前总管会话拥有的一次派活。',
        parameters: WaitParams,
        executionMode: 'sequential',
        execute: async (_toolCallId, params) => {
          const input = params as { runIds: string[]; timeoutMs?: number }
          return this.toolResult(await this.track(this.wait(managerSessionId, input.runIds[0]!, input.timeoutMs)))
        },
      },
      {
        name: 'list_agents',
        label: '查看派活',
        description: '列出当前总管会话的派活摘要。',
        parameters: ListParams,
        executionMode: 'sequential',
        execute: async () => this.toolResult(await this.track(this.list(managerSessionId))),
      },
    ]
  }

  async spawn(managerSessionId: string, input: SpawnRoleAgentInput): Promise<{
    runId: AgentRunId
    status: 'running' | 'rejected'
    targetRoleName: string
  }> {
    if (!this.accepting) throw new Error('应用正在退出，不能再派出新任务')
    const { role, envelope } = await this.validateSpawn(managerSessionId, input)
    const runId = this.newRunId()
    let run: AgentRunRow
    try {
      run = await this.deps.roles.createAgentRun({
        runId,
        managerSessionId,
        targetRoleId: role.id,
        targetRoleNameSnapshot: role.displayName,
        envelope,
      })
    } catch (error) {
      if (error instanceof AgentRunSlotOccupiedError) {
        throw new Error('已有一项派活正在进行，请先等它结束再派下一项')
      }
      throw error
    }
    await this.emit(run)
    return this.requestApprovalAndExecute(run, envelope)
  }

  /** 仅供 E2E 启动夹具：把直写库的 awaiting run 接回真实确认与执行链。 */
  resumeAwaitingRunForE2E(runId: AgentRunId): Promise<void> {
    return this.track(this.resumeAwaitingRunForE2ETracked(runId))
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
  ): Promise<{ runId: AgentRunId; status: 'running' | 'rejected'; targetRoleName: string }> {
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
      return { runId, status: 'rejected', targetRoleName: run.targetRoleNameSnapshot }
    }

    try {
      run = await this.deps.roles.transitionAgentRun(runId, { status: 'queued' })
    } catch (error) {
      if (isInvalidatedRunError(error)) return invalidatedSpawnResult(initialRun)
      throw error
    }
    await this.emit(run)
    const selection = await this.deps.selection()
    let internalSessionId: string | undefined
    try {
      const detail = await this.deps.sessions.createInternalSession({
        roleId: run.targetRoleId,
        workspacePath: envelope.allowedWorkspacePaths[0]!,
        providerId: selection.providerId,
        modelId: selection.modelId,
      })
      internalSessionId = detail.summary.id
      run = await this.deps.roles.transitionAgentRun(runId, {
        status: 'running',
        internalSessionId,
      })
      await this.emit(run)
    } catch (error) {
      if (internalSessionId) await this.deps.sessions.remove(internalSessionId).catch(() => {})
      if (isInvalidatedRunError(error)) return invalidatedSpawnResult(initialRun)
      try {
        run = await this.deps.roles.transitionAgentRun(runId, {
          status: 'failed',
          failureMessage: '内部任务会话创建失败，本次没有执行',
        })
      } catch (transitionError) {
        if (isInvalidatedRunError(transitionError)) return invalidatedSpawnResult(initialRun)
        throw transitionError
      }
      await this.emit(run)
      throw new Error(error instanceof Error ? error.message : '内部任务会话创建失败')
    }

    const task = this.executeWorker(runId, internalSessionId, selection, envelope)
    this.active.set(runId, task)
    void task.then(
      () => this.active.delete(runId),
      () => this.active.delete(runId),
    )
    return { runId, status: 'running', targetRoleName: run.targetRoleNameSnapshot }
  }

  async wait(managerSessionId: string, runId: AgentRunId, timeoutMs = 30_000): Promise<unknown> {
    const timeout = Math.max(10_000, Math.min(300_000, Math.trunc(timeoutMs)))
    let run = await this.ownedRun(managerSessionId, runId)
    if (TERMINAL.has(run.status)) return this.waitResult(run, false)
    try {
      run = await this.deps.roles.transitionAgentRun(runId, {
        status: 'waiting',
        waitingReason: 'manager-wait',
      })
      await this.emit(run)
    } catch (error) {
      if (!(error instanceof AgentRunTransitionError)) throw error
      run = await this.ownedRun(managerSessionId, runId)
      if (TERMINAL.has(run.status)) return this.waitResult(run, false)
      // queued/running/waiting 的并发变化由下面的 active 等待与最终重读收敛。
    }
    const task = this.active.get(runId)
    if (task) {
      await this.waitWithTimeout(task, timeout)
    }
    run = await this.ownedRun(managerSessionId, runId)
    return this.waitResult(run, !TERMINAL.has(run.status))
  }

  async list(managerSessionId: string): Promise<unknown> {
    return this.deps.query.list(managerSessionId)
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

  private async waitResult(run: AgentRunRow, timedOut: boolean): Promise<unknown> {
    const summary = await this.deps.query.summary(run)
    return timedOut
      ? { timedOut: true, currentStatus: run.status, run: summary }
      : { timedOut: false, currentStatus: run.status, result: run.result, usage: summary.usage, violations: run.boundaryViolations }
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

  private waitWithTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      void task.then(
        () => { clearTimeout(timer); resolve() },
        () => { clearTimeout(timer); resolve() },
      )
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
const SpawnParams = Type.Object({ targetRoleId: Type.String({ pattern: '^agent-[0-9a-f]{12}$' }), ...EnvelopeFields }, { additionalProperties: false })
const WaitParams = Type.Object({
  runIds: Type.Array(Type.String({ pattern: '^run-[0-9a-f]{16}$' }), { minItems: 1, maxItems: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 300_000 })),
}, { additionalProperties: false })
const ListParams = Type.Object({}, { additionalProperties: false })

const INVALIDATED_SPAWN_MESSAGE = '这次派活已失效(角色刚被删除或归档),请告知用户'

function isInvalidatedRunError(error: unknown): boolean {
  return error instanceof AgentRunTransitionError
    || (error instanceof Error && error.message.startsWith('派活不存在:'))
}

function invalidatedSpawnResult(run: AgentRunRow): {
  runId: AgentRunId
  status: 'rejected'
  targetRoleName: string
  error: string
} {
  return {
    runId: run.runId,
    status: 'rejected',
    targetRoleName: run.targetRoleNameSnapshot,
    error: INVALIDATED_SPAWN_MESSAGE,
  }
}
