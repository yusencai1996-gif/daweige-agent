import type {
  AgentRunDetail,
  AgentRunGraph,
  AgentRunSummary,
  AgentRunUsage,
} from '../../shared/domain/manager'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import type { AgentService } from '../agent/agent-service'
import type { RoleRepository, AgentRunRow } from '../roles/role-repository'
import type { SessionService } from '../storage/session-service'
import type { UsageStore } from '../usage/usage-store'

const ZERO_USAGE: AgentRunUsage = {
  rounds: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
}

export class AgentRunOwnershipError extends Error {
  constructor() {
    super('派活记录不存在，或不属于当前总管会话')
    this.name = 'AgentRunOwnershipError'
  }
}

/** roles.sqlite 的 run 与 usage/pi 会话只读拼装层。 */
export class AgentRunQueryService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
    private readonly usage?: UsageStore,
  ) {}

  async list(managerSessionId: string): Promise<AgentRunSummary[]> {
    await this.assertManagerSession(managerSessionId)
    return this.summarize(await this.roles.listAgentRuns(managerSessionId))
  }

  async listAll(): Promise<AgentRunSummary[]> {
    return this.summarize(await this.roles.listAgentRuns())
  }

  /** managerSessionId 必填(复审整改复验:调用方声明必须校验,不从 row 反推 owner)。 */
  async getDetail(runId: string, managerSessionId: string): Promise<AgentRunDetail> {
    const row = await this.roles.getAgentRun(runId)
    if (!row) throw new AgentRunOwnershipError()
    // 调用方 ownership(阶段复审整改):不只确认 owner 是合法 manager,
    // 还要求调用方声明的 manager 会话与 run 归属一致(对齐 getGraph/interrupt 边界)
    await this.assertManagerSession(managerSessionId)
    if (row.managerSessionId !== managerSessionId) throw new AgentRunOwnershipError()
    const [run] = await this.summarize([row])
    if (!run) throw new AgentRunOwnershipError()
    let childSession: AgentRunDetail['childSession'] = null
    if (row.internalSessionId) {
      try {
        const detail = await this.sessions.openDetail(row.internalSessionId)
        const messages = await this.agent.restoreChatMessages(row.internalSessionId)
        childSession = { ...detail, messages }
      } catch {
        childSession = null
      }
    }
    return { run, envelope: row.envelope, result: row.result, childSession, readOnly: true }
  }

  async summary(row: AgentRunRow): Promise<AgentRunSummary> {
    const [summary] = await this.summarize([row])
    if (!summary) throw new Error('派活摘要组装失败')
    return summary
  }

  /** 协作链整图(0.4.0 D):归属校验后拼 nodes+edges+aggregate(图状态完全由 DTO 推导)。 */
  async getGraph(graphId: string, managerSessionId: string): Promise<AgentRunGraph> {
    await this.assertManagerSession(managerSessionId)
    const { rows, edges } = await this.roles.getAgentRunGraph(graphId)
    if (rows.length === 0) throw new AgentRunOwnershipError()
    // graph 上任意节点归属都应一致(建链时已校验同 manager;防手改库)
    for (const row of rows) {
      if (row.managerSessionId !== managerSessionId) throw new AgentRunOwnershipError()
    }
    const nodes = await this.summarize(rows)
    const active = nodes.filter(
      (n) =>
        n.status === 'running' || n.status === 'waiting' ||
        n.status === 'queued' || n.status === 'awaiting-approval',
    ).length
    return {
      graphId,
      managerSessionId,
      nodes,
      edges: edges.map((e) => ({ fromRunId: e.from, toRunId: e.to, kind: e.kind })),
      aggregate: {
        active,
        completed: nodes.filter((n) => n.status === 'completed').length,
        failed: nodes.filter((n) => n.status === 'failed' || n.status === 'rejected').length,
        interrupted: nodes.filter((n) => n.status === 'interrupted').length,
        totalTokens: nodes.reduce((sum, n) => sum + n.usage.totalTokens, 0),
      },
    }
  }

  private async summarize(rows: readonly AgentRunRow[]): Promise<AgentRunSummary[]> {
    const ids = rows.flatMap((row) => row.internalSessionId ? [row.internalSessionId] : [])
    const totals = this.usage
      ? await this.usage.getSessionTotals(ids).catch((error) => {
          console.error('[manager] 派活用量查询失败，本次卡片先显示零：', error instanceof Error ? error.message : error)
          return new Map<string, AgentRunUsage>()
        })
      : new Map<string, AgentRunUsage>()
    return rows.map((row) => ({
      runId: row.runId,
      managerSessionId: row.managerSessionId,
      targetRoleId: row.targetRoleId,
      targetRoleName: row.targetRoleNameSnapshot,
      internalSessionId: row.internalSessionId,
      parentRunId: row.parentRunId,
      status: row.status,
      waitingReason: row.waitingReason,
      graphId: row.graphId,
      dependsOnRunIds: row.dependsOnRunIds,
      queueReason: row.queueReason,
      followupCount: row.followupCount,
      interruptSource: row.interruptSource,
      taskBrief: row.envelope.taskBrief,
      allowedWorkspacePaths: row.envelope.allowedWorkspacePaths,
      usage: row.internalSessionId ? (totals.get(row.internalSessionId) ?? ZERO_USAGE) : ZERO_USAGE,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
      ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    }))
  }

  /** ownership 断言公开给受控写通道(interrupt 等):managerSessionId 必须是真实可见的总管用户会话。 */
  assertManagerSessionOwnership(sessionId: string): Promise<void> {
    return this.assertManagerSession(sessionId)
  }

  private async assertManagerSession(sessionId: string): Promise<void> {
    const binding = await this.roles.getBinding(sessionId)
    if (binding?.roleId !== SYSTEM_MANAGER_ROLE_ID || binding.visibility !== 'user') {
      throw new AgentRunOwnershipError()
    }
  }
}
