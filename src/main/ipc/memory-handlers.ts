import { registerHandler } from './handler'
import type { MemoryStore } from '../memory/memory-store'

/**
 * 记忆管理 IPC(验收新增:设置页可看可删)。
 * 数据只在本机;删除是用户主动行为,直接执行(行内二次确认在 UI 层做)。
 */

export function registerMemoryHandlers(memoryStore: MemoryStore): void {
  registerHandler('memory:list', async () => memoryStore.all())

  registerHandler('memory:delete', async ({ memoryId }) => {
    const deleted = await memoryStore.remove(memoryId)
    return { deleted }
  })
}
