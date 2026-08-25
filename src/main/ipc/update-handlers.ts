import { registerHandler } from './handler'
import type { UpdateService } from '../update/update-service'

/** 更新 IPC(设置页「关于与更新」)。 */

export function registerUpdateHandlers(updateService: UpdateService): void {
  registerHandler('app:checkUpdate', async () => updateService.check())

  registerHandler('update:download', async () => updateService.download())

  registerHandler('update:install', async () => {
    updateService.install()
  })
}
