import { registerHandler, ipcError } from './handler'
import type { SettingsStore } from '../storage/settings-store'
import type { RoleRepository } from '../roles/role-repository'
import { pruneRoleModelDefaults } from '../../shared/domain/model-selection'
import type { Settings } from '../../shared/domain/settings'

/** 设置 IPC(M2-04;0.4.0 A 加 managerWorkspacePath 防绕过)。 */

export function registerSettingsHandlers(store: SettingsStore, roles?: RoleRepository): void {
  registerHandler('settings:get', async () => store.load())

  registerHandler('settings:update', async ({ settings }) => {
    // 0.4.0 A(A-14):总管工作区路径只能走 managerWorkspace:migrate 专用迁移流程
    // (选择器授权+全量拷贝+校验)。双保险:
    // ① 显式携带不同值 → 拒绝(给 renderer 明确错误信号);
    // ② 未携带该字段(过期快照整体覆盖)→ 服务端强制保留当前值,防迁移结果被抹。
    const current = store.current()
    const protectedValue = current?.managerWorkspacePath
    if (
      settings.managerWorkspacePath !== undefined &&
      settings.managerWorkspacePath !== protectedValue
    ) {
      throw ipcError(
        'EINVALID_REQUEST',
        '小柊的工作文件夹不能在这里直接改;请到设置页「总管工作区」里选择新位置完成迁移',
      )
    }
    let normalized = pruneRoleModelDefaults({ ...settings, managerWorkspacePath: protectedValue })
    normalized = await pruneOrphanRoleDefaults(normalized, roles)
    return store.save(normalized)
  })
}

async function pruneOrphanRoleDefaults(settings: Settings, roles?: RoleRepository): Promise<Settings> {
  if (!roles || !settings.roleModelDefaults) return settings
  const next = { ...settings.roleModelDefaults }
  try {
    // ⑤审整改:逐 key 串行查库最多 128 次,并行化(本地 SQLite 小查询,无竞争)
    await Promise.all(
      Object.keys(next).map(async (roleId) => {
        if (roleId === 'sys-xiaozhen') return
        if (!(await roles.getRoleRow(roleId))) delete next[roleId]
      }),
    )
  } catch {
    // 角色库降级时不阻断设置页，也不误删仍可能有效的映射。
    return settings
  }
  if (Object.keys(next).length === Object.keys(settings.roleModelDefaults).length) return settings
  if (Object.keys(next).length > 0) return { ...settings, roleModelDefaults: next }
  const { roleModelDefaults: _removed, ...rest } = settings
  return rest
}
