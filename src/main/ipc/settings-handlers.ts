import { registerHandler, ipcError } from './handler'
import type { SettingsStore } from '../storage/settings-store'

/** 设置 IPC(M2-04;0.4.0 A 加 managerWorkspacePath 防绕过)。 */

export function registerSettingsHandlers(store: SettingsStore): void {
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
    return store.save({ ...settings, managerWorkspacePath: protectedValue })
  })
}
