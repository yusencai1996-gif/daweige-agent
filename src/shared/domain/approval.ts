/**
 * 文件操作确认卡片领域模型。
 * 铁律:卡片说人话(title/description 由主进程生成中文摘要),
 * 不向渲染进程透出代码 diff。
 */

export type ApprovalKind =
  | 'write' // 写入新文件 / 覆盖写
  | 'edit' // 编辑已有文件
  | 'move' // 移动
  | 'rename' // 重命名
  | 'delete' // 删除(走回收站,可恢复)
  | 'mkdir' // 新建目录
  | 'outside-read' // 读取工作文件夹外的文件
  | 'role-rules-edit' // AI 修改当前角色守则(永远逐次确认,不吃任何会话级授权)

export interface ApprovalRequest {
  /** 确认 ID:主进程生成的唯一随机串;伪造/重复响应会被拒绝。 */
  readonly id: string
  readonly kind: ApprovalKind
  /** 人话标题,如"我要移动 38 个文件"。 */
  readonly title: string
  /** 人话说明:将对哪些文件做什么、影响多少项、是否可恢复。 */
  readonly description: string
  /** 受影响项数量。 */
  readonly itemCount: number
  /** 最多 5 条示例路径(绝对路径)。 */
  readonly samplePaths: readonly string[]
  /** 删除是否走回收站(可恢复)。 */
  readonly recoverable: boolean
  /** 目标是否在工作文件夹之外。 */
  readonly outsideWorkspace: boolean
  /** 关联的工具调用(便于 UI 把卡片与工具状态对齐)。 */
  readonly toolCallId?: string
  /** 发起工具名(如 move_paths);UI 据此决定能否显示"本次会话全部允许"。 */
  readonly toolName?: string
  readonly createdAt: number
}

/**
 * approve:本次放行
 * approve-session:本次放行,且本会话内该工具(工作区内、非删除)后续免再弹卡
 * reject:拒绝,可附言
 */
export type ApprovalDecision = 'approve' | 'approve-session' | 'reject'

export interface ApprovalResponse {
  readonly approvalId: string
  readonly decision: ApprovalDecision
  /** 拒绝时的可选单行附言;非空时作为 block reason 回传模型。 */
  readonly note?: string
}
