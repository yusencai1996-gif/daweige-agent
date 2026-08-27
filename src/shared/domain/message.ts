/**
 * 消息与工具执行领域模型。
 * 判别字段:role。
 */

export type MessageRole = 'user' | 'assistant' | 'error'

/**
 * 工具执行状态(对应确认卡片与工具过程展示)。
 * - pending: 等待用户确认(确认卡片已弹出)
 * - running: 已批准/免确认,执行中
 * - succeeded / rejected / failed: 终态
 */
export type ToolExecutionStatus = 'pending' | 'running' | 'succeeded' | 'rejected' | 'failed'

export interface ToolExecutionInfo {
  readonly toolCallId: string
  /** 工具名(英文标识,如 move_files)。 */
  readonly toolName: string
  /** 中显示名(如"移动文件")。 */
  readonly displayName: string
  readonly status: ToolExecutionStatus
  /** 一句话人话摘要,如"移动 38 张图片到按月份建的文件夹"。 */
  readonly summary?: string
  /** 失败原因(中文,可直接展示)。 */
  readonly error?: string
  /**
   * 命令执行详情(0.4.0 C,toolName='run_command' 时携带):
   * 刷新后从 pi 工具结果重建;实时输出靠 command_output 推送,恢复态只有终值。
   */
  readonly command?: import('./command').CommandResultDetails
}

export type ChatMessage =
  | {
      readonly kind: 'chat'
      readonly id: string
      readonly role: 'user'
      readonly text: string
      readonly createdAt: number
    }
  | {
      readonly kind: 'chat'
      readonly id: string
      readonly role: 'assistant'
      readonly text: string
      readonly createdAt: number
      /** 思考过程全文(A-02:前端渲染为可折叠思考块);无思考时缺省。 */
      readonly thinking?: string
      readonly toolExecutions?: readonly ToolExecutionInfo[]
    }
  | {
      readonly kind: 'error'
      readonly id: string
      readonly role: 'error'
      readonly text: string
      readonly createdAt: number
      /** 可重试错误给"重试"按钮。 */
      readonly retryable: boolean
    }

/** 穷尽性助手:switch 全分支后 default 分支收窄为 never。 */
export function assertNeverMessageRole(role: never): never {
  throw new Error(`未处理的消息角色: ${String(role)}`)
}
