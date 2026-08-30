import { ipcError, registerHandler } from './handler'
import type { AgentRunQueryService } from '../manager/agent-run-query-service'
import type { RoleRepository } from '../roles/role-repository'
import type { AgentService } from '../agent/agent-service'
import type { ApprovalBroker } from '../agent/approval-broker'
import type { AgentPushEvent } from '../../shared/ipc/events'

/**
 * 派活只读/受控通道(0.3.0 list/detail;0.4.0 D getGraph/interrupt)。
 * interrupt 是受控写:主进程查 ownership/状态,先 DB CAS 落 interrupted 再 abort 运行时
 * (PLAN §6.6 先落库防完成竞态覆盖;runner 终态重读不覆盖在 interrupt 专项批深化)。
 */
export function registerAgentRunHandlers(
  query?: AgentRunQueryService,
  deps?: {
    readonly roles?: RoleRepository
    readonly agent?: AgentService
    readonly broker?: ApprovalBroker
    /** 推送 agent_run_updated(interrupt 改库后主动发,族谱图缓存靠它失效)。 */
    readonly emitEvent?: (event: AgentPushEvent) => void
    /** interrupt 释放并发槽/租约后触发调度(排队中的派活可能可以启动)。 */
    readonly onRunInterrupted?: () => void
  },
): void {
  registerHandler('agentRun:list', async ({ managerSessionId }) => {
    if (!query) return []
    try {
      return await query.list(managerSessionId)
    } catch (error) {
      throw mapQueryError(error)
    }
  })
  registerHandler('agentRun:getDetail', async ({ runId, managerSessionId }) => {
    if (!query) throw ipcError('ESESSION_NOT_FOUND', '派活记录不存在')
    try {
      return await query.getDetail(runId, managerSessionId)
    } catch (error) {
      throw mapQueryError(error)
    }
  })
  registerHandler('agentRun:getGraph', async ({ graphId, managerSessionId }) => {
    if (!query) throw ipcError('ESESSION_NOT_FOUND', '协作链不存在')
    try {
      return await query.getGraph(graphId, managerSessionId)
    } catch (error) {
      throw mapQueryError(error)
    }
  })
  registerHandler('agentRun:interrupt', async ({ runId, managerSessionId }) => {
    const roles = deps?.roles
    if (!roles || !query) throw ipcError('EINTERNAL', '派活运行时未就绪')
    try {
      // ownership 双重校验:managerSessionId 必须是真实可见的总管会话(不能只信 renderer 配对的字符串),
      // 且 run 归属它——伪造别人会话 id 的 renderer 在这里被挡
      await query.assertManagerSessionOwnership(managerSessionId)
      const row = await roles.getAgentRun(runId)
      if (!row || row.managerSessionId !== managerSessionId) {
        throw ipcError('ESESSION_NOT_FOUND', '派活记录不存在，或不属于当前总管会话')
      }
      // 已终态:幂等返回最新状态(重复请求不报错)
      if (
        row.status === 'completed' || row.status === 'failed' ||
        row.status === 'rejected' || row.status === 'interrupted'
      ) {
        return (await query.summary(row))
      }
      // 先 DB CAS 落 interrupted(user):后续 runner 完成写入会被状态机拒绝,不覆盖
      let interrupted
      try {
        interrupted = await roles.transitionAgentRun(runId, {
          status: 'interrupted',
          failureMessage: '用户打断了这条派活;已完成的产出保留,未完成的没有继续',
          interruptSource: 'user',
        })
      } catch {
        // 并发双打断竞态:第二个 transition 撞非法转换——重读按幂等语义返回最新状态
        const latest = await roles.getAgentRun(runId)
        if (latest && (latest.status === 'interrupted' || latest.status === 'completed' ||
            latest.status === 'failed' || latest.status === 'rejected')) {
          return (await query.summary(latest))
        }
        throw new Error('派活刚被别人处理,请刷新再看')
      }
      // 运行时收尾:internal 会话 abort + 该会话挂起的确认卡按拒绝收尾;
      // awaiting 阶段(无 internal 会话)的派活确认卡按 runId 精确拒绝(codex 阶段复审整改)
      if (interrupted.internalSessionId) {
        deps?.agent?.abort(interrupted.internalSessionId)
        deps?.broker?.abortAllForSession(
          interrupted.internalSessionId,
          '派活被打断，本次未执行',
        )
      } else {
        deps?.broker?.abortDelegationForRun(runId, '派活被打断，本次未派出')
      }
      const summary = await query.summary(interrupted)
      // 状态推送(interrupt 不走 orchestrator 的 emit 链,这里主动发):
      // renderer 的派活卡/族谱图缓存都靠 agent_run_updated 失效刷新(codex 复验整改)
      deps?.emitEvent?.({
        type: 'agent_run_updated',
        managerSessionId,
        run: summary,
      })
      // 释放的并发槽/租约可能让排队派活满足启动条件
      deps?.onRunInterrupted?.()
      return summary
    } catch (error) {
      throw mapQueryError(error)
    }
  })
}

function mapQueryError(error: unknown): unknown {
  if (error instanceof Error && error.name === 'AgentRunOwnershipError') {
    return ipcError('ESESSION_NOT_FOUND', error.message)
  }
  return error
}
