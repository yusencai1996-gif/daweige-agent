import type { ProviderId } from './provider'
import type { RoleId } from './role'

/**
 * 会话领域模型。
 * 时间统一 epoch 毫秒(number),保证 IPC 序列化安全。
 */

/** 侧栏列表项。 */
export interface SessionSummary {
  readonly id: string
  /** 显示名;默认取首条用户消息摘要,用户可改名。 */
  readonly title: string
  /** 该会话的工作文件夹(绝对路径);AI 默认只在这个文件夹里干活。 */
  readonly workspacePath: string
  /**
   * 所属角色。null 仅出现在迁移完成前的过渡期或绑定损坏防御场景;
   * 迁移(0.2.0)上线后所有会话均有绑定。
   */
  readonly roleId: RoleId | null
  /** 非空=该会话已单独归档(角色主列表隐藏,归档区可恢复)。 */
  readonly archivedAt: number | null
  readonly providerId: ProviderId
  readonly modelId: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
}

/** 打开会话时的完整数据(含历史消息)。 */
export interface SessionDetail {
  readonly summary: SessionSummary
  readonly messages: readonly import('./message').ChatMessage[]
}
