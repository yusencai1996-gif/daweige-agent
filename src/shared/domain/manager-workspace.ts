/**
 * 小柊(总管)工作区状态与迁移契约——0.4.0 A(A-14)。
 * 需求:总管工作文件夹可自选,不默认占 C 盘;迁移只能走 managerWorkspace:migrate 专用通道。
 */

/** 总管工作区当前状态(get 与 migrate 的响应)。 */
export interface ManagerWorkspaceState {
  /** 当前生效路径(默认=userData/daweige/system/sys-xiaozhen/workspace,或用户迁移后的覆盖路径)。 */
  readonly effectivePath: string
  /** 是否仍为内置默认路径。 */
  readonly isDefault: boolean
  /** 迁移后是否需要重启应用才完全生效(会话绑定与启动种子化在下次启动收敛)。 */
  readonly restartRequired: boolean
  /** 迁移完成后旧目录清理提示(如旧目录仍有文件未能自动清理时给出人话说明)。 */
  readonly cleanupWarning?: string
}

/** managerWorkspace:migrate 请求。targetPath 必须先经 workspace:choose 选择器授权。 */
export interface ManagerWorkspaceMigrateRequest {
  readonly targetPath: string
}
