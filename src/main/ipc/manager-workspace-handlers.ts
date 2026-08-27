import { registerHandler, ipcError } from './handler'
import type { WorkspaceAuthorization } from './workspace-auth'
import type { ManagerWorkspaceMigrationService } from '../manager-workspace/migration-service'
import {
  ManagerWorkspaceMigrationError,
} from '../manager-workspace/migration-service'
import { ManagerWorkspaceUnavailableError } from '../manager-workspace/resolver'

/**
 * 总管工作区 IPC——0.4.0 A(A-14)。
 * migrate 的 targetPath 必须先经 workspace:choose 系统选择器授权(一次性票据),
 * renderer 不能提交任意未选择路径(与 role:create 挂载同一防线)。
 */
export function registerManagerWorkspaceHandlers(deps: {
  migration: ManagerWorkspaceMigrationService
  workspaceAuth: WorkspaceAuthorization
}): void {
  registerHandler('managerWorkspace:get', async () => {
    try {
      return await deps.migration.currentState()
    } catch (err) {
      if (err instanceof ManagerWorkspaceUnavailableError) {
        throw ipcError('EINVALID_REQUEST', err.message)
      }
      throw err
    }
  })

  registerHandler('managerWorkspace:migrate', async ({ targetPath }) => {
    // 一次性消费系统选择器授权(缺省即拒,防任意路径)
    const authorized = await deps.workspaceAuth.consume(targetPath)
    if (authorized !== true) {
      throw ipcError(
        'EINVALID_REQUEST',
        '这个文件夹没有经过选择确认:请在设置里点"选择文件夹",在弹出的窗口里重新选择',
      )
    }
    try {
      return await deps.migration.migrate(targetPath)
    } catch (err) {
      if (
        err instanceof ManagerWorkspaceMigrationError ||
        err instanceof ManagerWorkspaceUnavailableError
      ) {
        throw ipcError('EINVALID_REQUEST', err.message)
      }
      throw err
    }
  })
}
