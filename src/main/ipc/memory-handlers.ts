import type { GlobalMemoryStore } from '../memory/global-memory-store'
import { ipcError, registerHandler } from './handler'

export function registerMemoryHandlers(store: GlobalMemoryStore): void {
  const recover = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation() }
    catch { throw ipcError('EINTERNAL', '记忆目录当前不可用，请检查目录后重启应用；原记忆文件不会被删除。') }
  }
  registerHandler('memory:list', async (request) => recover(() => store.listPage(request)))
  registerHandler('memory:delete', async ({ memoryId }) => recover(() => store.delete(memoryId)))
  registerHandler('memory:clear', async () => recover(() => store.clear()))
}
