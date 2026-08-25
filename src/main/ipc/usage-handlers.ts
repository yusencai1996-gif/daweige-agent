import { registerHandler } from './handler'
import type { UsageService } from '../usage/usage-service'

/**
 * 使用统计 IPC(usage:getDashboard)。
 * 一次返回整页数据;查询在存储队列内取一致快照,内部错误统一转中文 IPC 错误。
 */

export function registerUsageHandlers(usageService: UsageService): void {
  registerHandler('usage:getDashboard', async () => usageService.getDashboard())
}
