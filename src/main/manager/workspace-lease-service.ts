import type { RoleRepository } from '../roles/role-repository'
import { canonicalWorkspaceKey } from '../roles/role-files'

/**
 * 工作区租约门(0.4.0 D,PLAN §6.4/§7.3,阶段复审阻断整改):
 * delegated run 持有租约期间,普通用户会话/总管会话的**写与命令**不得碰被占根
 * (读不受限)——fail-closed 并给人话提示,不弹一张注定不能执行的写卡。
 * delegated child 自身不经过这里:它的互斥在 acquireLeasesAndStart 启动时已保证。
 */
export class WorkspaceLeaseService {
  constructor(private readonly roles: RoleRepository) {}

  /**
   * 目标路径中任一落在活跃派活租约上(相等或父子)即抛人话错误;
   * 无冲突静默通过。路径不存在的留给写工具自己的错误处理。
   */
  async assertNotLeased(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const canonicals: string[] = []
    for (const path of paths) {
      const key = await canonicalWorkspaceKey(path).catch(() => undefined)
      if (key !== undefined) canonicals.push(key)
    }
    if (canonicals.length === 0) return
    const conflicts = await this.roles.findLeaseConflicts(canonicals, 'run-none')
    if (conflicts.length === 0) return
    const first = conflicts[0]!
    throw new Error(
      `这个文件夹正被一条派活使用(${first.canonicalRoot}),等它结束再试;读取不受影响`,
    )
  }
}
