import type {
  AgentRunDetail,
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

  async getDetail(runId: string): Promise<AgentRunDetail> {
    const row = await this.roles.getAgentRun(runId)
    if (!row) throw new AgentRunOwnershipError()
    await this.assertManagerSession(row.managerSessionId)
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

  private async assertManagerSession(sessionId: string): Promise<void> {
    const binding = await this.roles.getBinding(sessionId)
    if (binding?.roleId !== SYSTEM_MANAGER_ROLE_ID || binding.visibility !== 'user') {
      throw new AgentRunOwnershipError()
    }
  }
}
