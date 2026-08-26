import type { AgentService } from '../agent/agent-service'
import type { ApprovalBroker } from '../agent/approval-broker'
import type { RoleRepository } from '../roles/role-repository'
import type { SessionService } from '../storage/session-service'

export class ManagerCleanupBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagerCleanupBusyError'
  }
}

/** 角色/总管会话删除时的跨 roles/pi 清理入口；usage_events 刻意保留。 */
export class ManagerCleanupService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
    private readonly approvals: ApprovalBroker,
  ) {}

  async assertTargetRoleIdle(roleId: string): Promise<void> {
    if (await this.roles.hasActiveAgentRuns({ targetRoleId: roleId })) {
      throw new ManagerCleanupBusyError('这个角色还有派活正在进行，先等派活结束再归档或删除')
    }
  }

  async assertManagerSessionIdle(managerSessionId: string): Promise<void> {
    if (await this.roles.hasActiveAgentRuns({ managerSessionId })) {
      throw new ManagerCleanupBusyError('这条总管会话还有派活正在进行，先等派活结束再归档或删除')
    }
  }

  async internalSessionIdsForRole(roleId: string): Promise<readonly string[]> {
    const runs = await this.roles.listAgentRunsByTargetRole(roleId)
    return runs.flatMap((run) => run.internalSessionId ? [run.internalSessionId] : [])
  }

  async cleanupTargetRole(roleId: string): Promise<void> {
    await this.assertTargetRoleIdle(roleId)
    const ids = await this.internalSessionIdsForRole(roleId)
    await this.removeInternalSessions(ids, '角色已归档，本次内部任务已清理')
    await this.roles.deleteAgentRunsByTargetRole(roleId)
  }

  async cleanupManagerSession(managerSessionId: string): Promise<void> {
    await this.assertManagerSessionIdle(managerSessionId)
    const runs = await this.roles.listAgentRuns(managerSessionId)
    const ids = runs.flatMap((run) => run.internalSessionId ? [run.internalSessionId] : [])
    await this.removeInternalSessions(ids, '总管会话已删除，本次内部任务已清理')
    await this.roles.deleteAgentRunsByManagerSession(managerSessionId)
  }

  private async removeInternalSessions(ids: readonly string[], reason: string): Promise<void> {
    for (const id of ids) {
      this.agent.disposeAgent(id)
      this.approvals.abortAllForSession(id, reason)
      this.approvals.clearSessionGrants(id)
      await this.sessions.remove(id)
    }
  }
}
