import type { BootstrapState } from '../../shared/ipc/contracts'
import { app } from 'electron'
import { PROVIDER_IDS } from '../../shared/domain/provider'
import type { CredentialStore } from '../security/credential-store'
import type { SettingsStore } from '../storage/settings-store'
import type { SessionService } from '../storage/session-service'
import type { ReminderService } from '../memory/reminder-service'
import type { RoleService } from '../roles/role-service'
import { registerHandler } from './handler'
import { PROVIDER_CATALOG } from './provider-catalog'

/**
 * 应用级 handler:bootstrap 汇总启动一次性状态(含 M5-03 提醒 + 0.2.0 角色)。
 */

export interface AppHandlerDeps {
  settingsStore: SettingsStore
  credentialStore: CredentialStore
  sessionService: SessionService
  reminderService: ReminderService
  roleService?: RoleService
  /** 启动迁移失败的中文说明(可选,专审整改:不再静默吞掉)。 */
  migrationError?: string
}

export function registerAppHandlers(deps: AppHandlerDeps): void {
  registerHandler('app:getBootstrapState', async (): Promise<BootstrapState> => {
    const [settings, sessions, upcomingReminders, roles] = await Promise.all([
      deps.settingsStore.load(),
      // 会话列表失败也不拦启动(极端:pi 库损坏时空列表,用户仍能进设置/关于)
      deps.sessionService.listSummaries().catch((err) => {
        console.error('[bootstrap] 会话列表读取失败,本次以空列表启动:', err instanceof Error ? err.message : err)
        return []
      }),
      deps.reminderService.listUpcoming(),
      // 角色库损坏时降级为空列表(会话照旧可用,roleId=null 归入前端「未分组」),不拦启动
      deps.roleService?.listSummaries().catch((err) => {
        console.error('[roles] 角色列表读取失败,本次以空列表启动:', err instanceof Error ? err.message : err)
        return []
      }) ?? Promise.resolve([]),
    ])
    return {
      appVersion: app.getVersion(),
      ...(deps.migrationError ? { migrationError: deps.migrationError } : {}),
      roles,
      sessions,
      settings,
      providers: [...PROVIDER_CATALOG],
      credentialStatuses: PROVIDER_IDS.map((id) => deps.credentialStore.status(id)),
      upcomingReminders,
    }
  })
  registerHandler('reminder:listUpcoming', async () => deps.reminderService.listUpcoming())
}
