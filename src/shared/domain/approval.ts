/**
 * 确认卡片领域模型(0.1 文件操作 + 0.3.0 派活)。
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
  | 'delegation' // 总管派活确认(0.3.0;同意才派出子 agent,不吃任何会话级授权)
  | 'command' // 命令运行确认(0.4.0;沙箱里跑,审批独立于文件授权)
  | 'skill-candidate' // 技能市场候选选择(0.7.0;逐次确认)
  | 'skill-install' // 技能安装预览(0.7.0;逐次确认)

/** 文件/守则操作确认卡(0.1~0.2 既有形态,字段不变)。 */
export interface FileApprovalRequest {
  readonly id: string
  readonly kind: Exclude<ApprovalKind, 'delegation' | 'command' | 'skill-candidate' | 'skill-install'>
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
  /** 受控技能逻辑 URI 写入时的 Markdown 预览；普通文件写入不提供。 */
  readonly contentPreview?: string
}

export interface SkillCandidateApprovalRequest {
  readonly id: string
  readonly kind: 'skill-candidate'
  readonly title: string
  readonly description: string
  readonly query: string
  readonly candidates: readonly import('./skill').SkillMarketCandidate[]
  readonly createdAt: number
  readonly toolCallId: string
}

export interface SkillInstallApprovalRequest {
  readonly id: string
  readonly kind: 'skill-install'
  readonly title: string
  readonly description: string
  readonly candidate: import('./skill').SkillMarketCandidate
  readonly markdownPreview: string
  readonly markdownBytes: number
  readonly previewTruncated: boolean
  readonly targetLogicalLocation: string
  readonly createdAt: number
  readonly toolCallId: string
}

/**
 * 派活确认卡(0.3.0):小柊请求派出子角色,用户点"同意派出"才真正 spawn。
 * 渲染层不在文件卡浮层渲染它,而是并入对应派活卡(PLAN §6.2/§10.4);
 * 响应仍走 approval:respond(approve=派出,reject=不派)。
 */
export interface DelegationApprovalRequest {
  readonly id: string
  readonly kind: 'delegation'
  readonly runId: import('./manager').AgentRunId
  readonly targetRoleId: string
  readonly targetRoleName: string
  readonly taskBrief: string
  readonly allowedWorkspacePaths: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  /** 人话标题,如"派给账房:汇总销售表"。 */
  readonly title: string
  /** 人话说明:任务简报 + 允许操作的文件夹摘要。 */
  readonly description: string
  readonly createdAt: number
}

export type ApprovalRequest =
  | FileApprovalRequest
  | DelegationApprovalRequest
  | SkillCandidateApprovalRequest
  | SkillInstallApprovalRequest
  | import('./command').CommandApprovalRequest

/**
 * approve:本次放行
 * approve-session:本次放行,且本会话内该工具(工作区内、非删除)后续免再弹卡
 * reject:拒绝,可附言
 */
export type ApprovalDecision = 'approve' | 'approve-session' | 'reject'

export interface ApprovalResponse {
  readonly approvalId: string
  readonly decision: ApprovalDecision
  /** skill-candidate 批准时必填；其余审批禁止携带。 */
  readonly selectedOptionId?: string
  /** 拒绝时的可选单行附言;非空时作为 block reason 回传模型。 */
  readonly note?: string
}
