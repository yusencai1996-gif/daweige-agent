import { ipcError, registerHandler } from './handler'
import type { AgentRunQueryService } from '../manager/agent-run-query-service'

/**
 * 0.3.0 批 1 占位:通道与 schema 已接通;真实查询/只读 internal detail 在批 3 接入。
 */
export function registerAgentRunHandlers(query?: AgentRunQueryService): void {
  registerHandler('agentRun:list', async ({ managerSessionId }) => {
    if (!query) return []
    try {
      return await query.list(managerSessionId)
    } catch (error) {
      throw mapQueryError(error)
    }
  })
  registerHandler('agentRun:getDetail', async ({ runId }) => {
    if (!query) throw ipcError('ESESSION_NOT_FOUND', '派活记录不存在')
    try {
      return await query.getDetail(runId)
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
