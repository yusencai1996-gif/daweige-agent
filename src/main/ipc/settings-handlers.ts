import { registerHandler } from './handler'
import type { SettingsStore } from '../storage/settings-store'

/** 设置 IPC(M2-04)。 */

export function registerSettingsHandlers(store: SettingsStore): void {
  registerHandler('settings:get', async () => store.load())

  registerHandler('settings:update', async ({ settings }) => {
    return store.save(settings)
  })
}
