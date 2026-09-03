import { shell } from 'electron'
import type { SkillCatalogService } from '../skills/skill-catalog-service'
import { ipcError, registerHandler } from './handler'

/** Gate 1 仅冻结通道；目录扫描与打开逻辑由技能后端批接入。 */
export function registerSkillHandlers(service?: SkillCatalogService): void {
  const requireService = (): SkillCatalogService => {
    if (!service) throw ipcError('EINTERNAL', '技能功能这次没有准备好,请重启应用再试')
    return service
  }
  registerHandler('skill:list', async () => requireService().list())
  registerHandler('skill:refresh', async () => requireService().refresh())
  registerHandler('skill:uninstall', async (request) => {
    try {
      return await requireService().uninstall(request, (path) => shell.trashItem(path))
    } catch (error) {
      throw ipcError('EINVALID_REQUEST', error instanceof Error ? error.message : '技能没有卸载')
    }
  })
  registerHandler('skill:openFolder', async (request) => {
    try {
      await requireService().openFolder(request, (path) => shell.openPath(path))
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      const safeMessage =
        detail.startsWith('找不到这个角色') ||
        detail.startsWith('技能文件夹是一个链接') ||
        detail.startsWith('系统没有打开技能文件夹')
          ? detail
          : '技能文件夹没有打开,请检查目录权限后重试'
      throw ipcError(
        'EINVALID_REQUEST',
        safeMessage,
      )
    }
  })
}
