import { registerHandler, ipcError } from './handler'
import type { RoleService, RoleError } from '../roles/role-service'
import type { SessionService } from '../storage/session-service'
import type { AgentService } from '../agent/agent-service'
import type { ApprovalBroker } from '../agent/approval-broker'
import type { WorkspaceAuthorization } from './workspace-auth'
import { canonicalWorkspaceKey, checkGuardrails } from '../roles/role-files'
import { listUserTemplates } from '../roles/role-templates'

/**
 * 角色 IPC(0.2.0 A6/A7):12 通道。
 * 安全要点:
 * - role:create 的挂载目录必须来自 workspace:choose 的一次性授权(消费后失效);
 * - 归档(角色/会话)前忙碌检查,流式回复/待确认卡在明处处理;
 * - 删除确认链:输名一致 + impactVersion 未过期;
 * - 角色错误码 → IpcError 中文,不透内部堆栈。
 */

export function registerRoleHandlers(deps: {
  roleService: RoleService
  sessionService: SessionService
  agentService?: AgentService
  approvalBroker?: ApprovalBroker
  workspaceAuth?: WorkspaceAuthorization
}): void {
  const { roleService, sessionService } = deps

  registerHandler('role:listTemplates', async () => listUserTemplates())

  registerHandler('role:list', async () => roleService.listSummaries())

  registerHandler('role:get', async ({ roleId }) => {
    try {
      return await roleService.getDetail(roleId)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:create', async (input) => {
    // 与授权无关的形状校验先做(免得校验失败白烧一次性授权,专审建议)
    const guardrailsCheck = checkGuardrails(input.guardrails)
    if (!guardrailsCheck.ok) {
      throw ipcError('EINVALID_REQUEST', guardrailsCheck.message!)
    }
    // 挂载授权(PLAN §6.3):每个 workspacePath 都必须消费一次系统选择器授权;
    // 必填(缺省抛错而非静默跳过,防御方向不能写反——专审建议)
    if (!deps.workspaceAuth) {
      throw ipcError('EINTERNAL', '角色功能初始化异常(授权层缺失),请重启应用')
    }
    for (const p of input.workspacePaths) {
      const authorized = await deps.workspaceAuth.consume(p)
      if (authorized !== true) {
        throw ipcError(
          'EINVALID_REQUEST',
          '这个文件夹没有经过选择确认:请在向导里点"选择文件夹",在弹出的窗口里重新选择',
        )
      }
    }
    try {
      return await roleService.createRole({
        displayName: input.displayName,
        workspacePaths: input.workspacePaths,
        primaryWorkspacePath: input.primaryWorkspacePath,
        templateId: input.templateId,
        guardrails: input.guardrails,
      })
    } catch (err) {
      throw mapRoleError(err, '角色没建成功')
    }
  })

  registerHandler('role:update', async ({ roleId, displayName }) => {
    try {
      return await roleService.updateDisplayName(roleId, displayName)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:updateGuardrails', async ({ roleId, guardrails, expectedVersion }) => {
    try {
      return await roleService.updateGuardrails(roleId, guardrails, expectedVersion)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:archive', async ({ roleId }) => {
    // 任一子会话忙碌时拒绝归档:不把运行中的审批/回复藏进归档区(PLAN §5.2)
    const sessionIds = await roleService.listSessionIdsOfRole(roleId)
    assertSessionsIdle(sessionIds, '归档这个角色')
    try {
      return await roleService.setRoleArchived(roleId, true)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:restore', async ({ roleId }) => {
    try {
      return await roleService.setRoleArchived(roleId, false)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:getDeleteImpact', async ({ roleId }) => {
    try {
      return await roleService.getDeleteImpact(roleId)
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  registerHandler('role:delete', async (input) => {
    try {
      return await roleService.deleteRole(input.roleId, input, {
        interruptSession: (sessionId) => deps.agentService?.disposeAgent(sessionId),
        settleApprovals: (sessionId) => {
          deps.approvalBroker?.abortAllForSession(sessionId, '角色已删除,本次未执行')
          deps.approvalBroker?.clearSessionGrants(sessionId)
        },
        removeSession: (sessionId) => sessionService.remove(sessionId),
      })
    } catch (err) {
      throw mapRoleError(err)
    }
  })

  function assertSessionsIdle(sessionIds: readonly string[], action: string): void {
    for (const sessionId of sessionIds) {
      if (deps.agentService?.isSessionStreaming(sessionId)) {
        throw ipcError('ESESSION_BUSY', `"${action}"前先处理:有会话正在回复,等它说完或点停止`)
      }
      if (deps.approvalBroker?.hasPendingForSession(sessionId)) {
        throw ipcError('ESESSION_BUSY', `"${action}"前先处理:有会话还有等你确认的操作`)
      }
    }
  }
}

/** RoleError → IpcError(中文);未知错误原样(由 handler 层兜底 EINTERNAL)。 */
function mapRoleError(err: unknown, fallback = '操作失败'): unknown {
  if (err instanceof Error && err.name === 'RoleError') {
    const roleErr = err as RoleError
    switch (roleErr.code) {
      case 'ROLE_NOT_FOUND':
        return ipcError('ESESSION_NOT_FOUND', roleErr.message)
      case 'GUARDRAILS_VERSION_CONFLICT':
        return ipcError('EROLE_CONFLICT', roleErr.message)
      case 'ROLE_DELETE_IMPACT_STALE':
      case 'ROLE_DELETE_CONFIRM_MISMATCH':
        // 删除确认链专用码:前端据此走"重新拉取影响清单"分支(初审严重项整改)
        return ipcError('EROLE_DELETE_CONFLICT', roleErr.message)
      case 'ROLE_DELETE_FAILED':
        return ipcError('EINTERNAL', roleErr.message)
      default:
        return ipcError('EINVALID_REQUEST', roleErr.message)
    }
  }
  if (err instanceof Error && /UNIQUE/i.test(err.message)) {
    return ipcError('EINVALID_REQUEST', '这个文件夹已经被别的角色使用了;一个文件夹只挂一位伙伴')
  }
  void fallback
  return err
}

/** 供接线层在启动时消费:归一化挂载 key(role:create 校验前置)。 */
export { canonicalWorkspaceKey }
