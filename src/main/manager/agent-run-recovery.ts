import type { RoleRepository } from '../roles/role-repository'
import type { SessionService } from '../storage/session-service'
import { readAppMeta } from '../storage/session-repository'

/** 启动时只收口，不自动重放任何可能写文件的 child。 */
export class AgentRunRecovery {
  constructor(
    private readonly roles: RoleRepository,
    private readonly sessions: SessionService,
  ) {}

  async reconcileOnStartup(options?: {
    /** 测试夹具需要把 awaiting 状态接回真实确认链；生产永远不传。 */
    readonly preserveAwaitingApproval?: boolean
  }): Promise<{ interrupted: number; removedOrphans: number }> {
    const interrupted = await this.roles.recoverInterruptedAgentRuns(
      Date.now(),
      options?.preserveAwaitingApproval === true,
    )
    const [bindings, runs] = await Promise.all([
      this.roles.listBindingRows(),
      this.roles.listAgentRuns(),
    ])
    const referenced = new Set(runs.flatMap((run) => run.internalSessionId ? [run.internalSessionId] : []))
    const metadata = await this.sessions.listAllMetadata()
    const markedInternal = new Set(
      metadata.filter((meta) => readAppMeta(meta)?.internal === true).map((meta) => meta.id),
    )
    const orphanIds = new Set(
      bindings
        .filter((binding) => binding.visibility === 'internal' && !referenced.has(binding.sessionId))
        .map((binding) => binding.sessionId),
    )
    // binding 写失败且 pi 补偿删除也失败时，只剩 appMeta 标记；同样在这里收口。
    for (const sessionId of markedInternal) {
      if (!referenced.has(sessionId)) orphanIds.add(sessionId)
    }
    for (const sessionId of orphanIds) {
      await this.sessions.remove(sessionId)
      await this.roles.deleteBinding(sessionId)
    }
    return { interrupted: interrupted.length, removedOrphans: orphanIds.size }
  }
}
