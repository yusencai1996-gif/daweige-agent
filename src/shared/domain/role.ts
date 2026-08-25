/**
 * 角色领域模型(0.2.0)——契约冻结,依据 docs/plans/roles-plan.md §2。
 *
 * 边界:roles.sqlite 是大微阁应用权威库(角色注册/挂载/绑定/归档);
 * 会话正文仍以 pi 的 sessions.sqlite 为唯一权威源,两边不互相改写。
 */

/** 角色 ID:稳定不变,与中文显示名解耦;显示名可改,绑定关系永不随之变化。 */
export type RoleId = string

/**
 * 角色类别。
 * - worker:普通干活角色(0.2.0 全部用户角色)
 * - manager:总管(第二步预留,公共创建接口不接受)
 * - legacy-unresolved:老会话迁移时找不到有效文件夹的兜底角色(禁止从它新建会话)
 */
export type RoleKind = 'worker' | 'manager' | 'legacy-unresolved'

/** 角色人设模板 ID。legacy-empty 仅迁移生成,创建向导不接受。 */
export type RoleTemplateId =
  | 'writer'
  | 'accountant'
  | 'file-steward'
  | 'notebook'
  | 'legacy-empty'

/** 创建向导可选的人设模板(role:listTemplates 返回;不含 legacy-empty)。 */
export interface RoleTemplate {
  readonly id: Exclude<RoleTemplateId, 'legacy-empty'>
  /** 中文名,如"写稿助手"。 */
  readonly name: string
  /** 一句话简介,向导模板卡展示。 */
  readonly description: string
  /** 守则草稿全文(本地常量生成,不调用模型);选中后预填守则编辑框。 */
  readonly guardrailsDraft: string
}

/** 角色挂载的工作文件夹。0.2.0 UI 单挂载,模型与 IPC 用数组,第一项为主挂载。 */
export interface RoleMount {
  /** 用户文件夹绝对路径(支持中文),AI 默认只在这里干活。 */
  readonly workspacePath: string
  readonly primary: boolean
  /** available=当前存在;missing=目录已不存在(角色仍展示,旧会话不丢)。 */
  readonly availability: 'available' | 'missing' | 'unknown'
}

/** 侧栏角色卡片数据。 */
export interface RoleSummary {
  readonly id: RoleId
  readonly kind: RoleKind
  readonly displayName: string
  readonly templateId: RoleTemplateId
  readonly mounts: readonly RoleMount[]
  /** 非空=整个角色已归档(主列表隐藏,可恢复)。 */
  readonly archivedAt: number | null
  /**
   * ready=正常;deleting=删除进行中;delete_failed=删除未完成(可重试,重启应用会续跑)。
   * delete_failed 的角色前端应标记"删除未完成",主列表禁用新建会话。
   */
  readonly lifecycle: 'ready' | 'deleting' | 'delete_failed' 
  readonly createdAt: number
  readonly updatedAt: number
  /** 该角色下全部用户可见会话数(含单独归档的)。 */
  readonly sessionCount: number
  /** 未归档会话数(卡头展示用)。 */
  readonly activeSessionCount: number
}

/** 角色内容档案(家目录 profile.json 的形状)。 */
export interface RoleProfile {
  readonly schemaVersion: 1
  readonly roleId: RoleId
  readonly templateId: RoleTemplateId
  readonly personaSummary: string
  readonly capabilityTags: readonly string[]
}

/** 角色详情(role:get / role:create 返回)。 */
export interface RoleDetail {
  readonly summary: RoleSummary
  readonly profile: RoleProfile
  /** 守则全文(markdown)。 */
  readonly guardrails: string
  /** 乐观并发控制:保存守则时必须原样带回 expectedVersion。 */
  readonly guardrailsVersion: number
}

/** 删除影响清单(role:getDeleteImpact 返回,确认时原样带回 impactVersion)。 */
export interface RoleDeleteImpact {
  readonly roleId: RoleId
  readonly displayName: string
  readonly sessionCount: number
  /** 最多 5 条子会话标题示例。 */
  readonly sessionTitles: readonly string[]
  /** 角色家目录(userData 内部相对展示路径,不透出绝对 userData 路径)。 */
  readonly homePath: string
  /** 防并发变化:roleId+updatedAt+排序后 sessionIds 计算;不一致即要求重新确认。 */
  readonly impactVersion: string
}

/** 角色删除结果。 */
export interface RoleDeleteResult {
  readonly deletedRoleId: RoleId
  readonly deletedSessionIds: readonly string[]
}
