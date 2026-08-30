import { registerHandler, ipcError } from './handler'
import type { SessionService } from '../storage/session-service'
import {
  InternalSessionAccessError,
  SessionCreateError,
  SessionNotFoundError,
} from '../storage/session-service'
import type { AgentService } from '../agent/agent-service'
import type { ApprovalBroker } from '../agent/approval-broker'
import type { ManagerCleanupService } from '../manager/manager-cleanup-service'
import type { SettingsStore } from '../storage/settings-store'
import { resolveRoleModel } from '../../shared/domain/model-selection'

/**
 * 会话 IPC(M2-06 + M3-04 + 0.2.0 A3)。
 * 0.2.0:session:create 按 roleId 从角色主挂载建会话(渲染层不再传路径);
 * session:archive/restore 只动角色库归档字段,忙碌会话拒绝归档。
 */

export function registerSessionHandlers(
  service: SessionService,
  agentService?: AgentService,
  approvalBroker?: ApprovalBroker,
  managerCleanup?: ManagerCleanupService,
  settingsStore?: SettingsStore,
): void {
  registerHandler('session:create', async ({ roleId }) => {
    try {
      if (!settingsStore) throw new SessionCreateError('设置服务不可用;暂时不能创建会话')
      const { selection } = resolveRoleModel(await settingsStore.load(), roleId)
      return await service.create({
        roleId,
        providerId: selection.providerId,
        modelId: selection.modelId,
      })
    } catch (err) {
      throw mapSessionError(err)
    }
  })

  registerHandler('session:list', async () => service.listSummaries())

  registerHandler('session:open', async ({ sessionId }) => {
    try {
      await service.assertUserVisibleSession(sessionId)
      const detail = await service.openDetail(sessionId)
      // M3-04:历史消息从 pi Session 恢复(agent 的 transcript 同源)
      const messages = agentService ? await agentService.restoreChatMessages(sessionId) : []
      return { ...detail, messages }
    } catch (err) {
      throw mapSessionError(err)
    }
  })

  registerHandler('session:rename', async ({ sessionId, title }) => {
    try {
      await service.assertUserVisibleSession(sessionId)
      return await service.rename(sessionId, title)
    } catch (err) {
      throw mapSessionError(err)
    }
  })

  registerHandler('session:delete', async ({ sessionId }) => {
    try {
      await service.assertUserVisibleSession(sessionId)
    } catch (err) {
      throw mapSessionError(err)
    }
    try {
      await managerCleanup?.cleanupManagerSession(sessionId)
    } catch (err) {
      throw mapSessionError(err)
    }
    agentService?.disposeAgent(sessionId)
    approvalBroker?.abortAllForSession(sessionId, '会话已删除,本次未执行')
    approvalBroker?.clearSessionGrants(sessionId)
    await service.remove(sessionId)
  })

  registerHandler('session:archive', async ({ sessionId }) => {
    try {
      await service.assertUserVisibleSession(sessionId)
      assertSessionIdle(sessionId, '归档')
      await managerCleanup?.assertManagerSessionIdle(sessionId)
      return await service.setArchived(sessionId, true)
    } catch (err) {
      throw mapSessionError(err)
    }
  })

  registerHandler('session:restore', async ({ sessionId }) => {
    try {
      await service.assertUserVisibleSession(sessionId)
      return await service.setArchived(sessionId, false)
    } catch (err) {
      throw mapSessionError(err)
    }
  })

  function assertSessionIdle(sessionId: string, action: string): void {
    // 忙碌会话不能藏进归档区:流式回复/待确认卡在明处处理完再归档(PLAN §5.1)
    if (agentService?.isSessionStreaming(sessionId)) {
      throw ipcError('ESESSION_BUSY', `会话正在回复,先等它说完或点停止,再${action}`)
    }
    if (approvalBroker?.hasPendingForSession(sessionId)) {
      throw ipcError('ESESSION_BUSY', `会话还有等你确认的操作,先处理完再${action}`)
    }
  }
}

function mapSessionError(err: unknown): unknown {
  if (err instanceof SessionNotFoundError) {
    return ipcError('ESESSION_NOT_FOUND', '会话不存在或已被删除')
  }
  if (err instanceof SessionCreateError) {
    return ipcError('EINVALID_REQUEST', err.message)
  }
  if (err instanceof InternalSessionAccessError) {
    return ipcError('EINVALID_REQUEST', err.message)
  }
  if (err instanceof Error && err.name === 'ManagerCleanupBusyError') {
    return ipcError('ESESSION_BUSY', err.message)
  }
  return err
}
