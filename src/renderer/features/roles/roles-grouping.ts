import type { RoleSummary, SessionSummary } from '../../../shared/domain'

/**
 * 角色侧栏 / 归档区的分组与过滤纯函数(B1)。
 * 契约:bootstrap/session:list 返回含已归档的全量数据,展示层在这里完成过滤分组,
 * 所有 CRUD 后的本地状态以 IPC 返回值为准(这些函数只负责"怎么摆",不伪造数据)。
 */

/**
 * 删除未完成(deleting/delete_failed)的角色不进主列表、只进归档区(B-04):
 * 主列表只摆「能正常干活」的角色,删除未完成的在归档区标记状态、等待续跑或重试。
 */
function isActiveRole(role: RoleSummary): boolean {
  return role.archivedAt === null && role.lifecycle === 'ready'
}

/** 归档区角色页签收留范围:已归档,或删除未完成(未归档但主列表禁用)。 */
function belongsToArchive(role: RoleSummary): boolean {
  return role.archivedAt !== null || role.lifecycle !== 'ready'
}

/** 侧栏主列表的一个角色分组:未归档角色 + 其下未归档会话(updatedAt 倒序)。 */
export interface RoleGroup {
  readonly role: RoleSummary
  readonly sessions: readonly SessionSummary[]
}

export interface SidebarGroups {
  /** 未归档角色,按创建时间正序(先到先得,稳定不跳动)。 */
  readonly roleGroups: readonly RoleGroup[]
  /** roleId 为 null 或指向不存在角色的未归档会话(防御:正常流程不出现)。 */
  readonly ungroupedSessions: readonly SessionSummary[]
}

/** 归档区「会话」页签的一组:某个未归档角色下被单独归档的会话。 */
export interface ArchivedSessionGroup {
  /** null = 角色已不存在/未分组的孤儿会话(防御)。 */
  readonly role: RoleSummary | null
  readonly sessions: readonly SessionSummary[]
}

export interface ArchiveGroups {
  /** 归档区角色:已归档 + 删除未完成(deleting/delete_failed),按归档时间倒序(未归档的排末尾)。 */
  readonly archivedRoles: readonly RoleSummary[]
  /** 独立归档会话按角色分组;角色已归档的会话不重复列在这里。 */
  readonly sessionGroups: readonly ArchivedSessionGroup[]
}

function byUpdatedAtDesc(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt
}

function byArchivedAtDesc(a: { readonly archivedAt: number | null }, b: { readonly archivedAt: number | null }): number {
  return (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
}

export function groupForSidebar(
  roles: readonly RoleSummary[],
  sessions: readonly SessionSummary[],
): SidebarGroups {
  // 0.3.0:总管(kind==='manager')由 ManagerCard 固定置顶展示,显式排除,不进普通组参与排序
  const activeRoles = roles
    .filter((r) => isActiveRole(r) && r.kind !== 'manager')
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
  const allRoleIds = new Set(roles.map((r) => r.id))
  const activeSessions = sessions.filter((s) => s.archivedAt === null)

  const roleGroups: RoleGroup[] = activeRoles.map((role) => ({
    role,
    sessions: activeSessions.filter((s) => s.roleId === role.id).slice().sort(byUpdatedAtDesc),
  }))
  // 已归档角色的会话随角色一起隐藏,不掉进未分组;只有 roleId 为 null / 角色真不存在才防御兜底
  const ungroupedSessions = activeSessions
    .filter((s) => s.roleId === null || !allRoleIds.has(s.roleId))
    .slice()
    .sort(byUpdatedAtDesc)

  return { roleGroups, ungroupedSessions }
}

export function groupForArchive(
  roles: readonly RoleSummary[],
  sessions: readonly SessionSummary[],
): ArchiveGroups {
  // 归档区角色页签 = 已归档 + 删除未完成(deleting/delete_failed,archivedAt 为 null 排末尾)
  const archivedRoles = roles.filter(belongsToArchive).slice().sort(byArchivedAtDesc)
  const archivedRoleIds = new Set(archivedRoles.map((r) => r.id))
  const roleById = new Map(roles.map((r) => [r.id, r]))

  // 只列「会话单独归档且其角色未归档」的;角色整体归档时子会话不重复展示。
  const standalone = sessions.filter(
    (s) => s.archivedAt !== null && (s.roleId === null || !archivedRoleIds.has(s.roleId)),
  )

  const byRole = new Map<string, SessionSummary[]>()
  const orphans: SessionSummary[] = []
  for (const s of standalone) {
    if (s.roleId !== null && roleById.has(s.roleId)) {
      const list = byRole.get(s.roleId) ?? []
      list.push(s)
      byRole.set(s.roleId, list)
    } else {
      orphans.push(s)
    }
  }

  const sessionGroups: ArchivedSessionGroup[] = roles
    .filter((r) => byRole.has(r.id))
    .map((r) => ({
      role: r,
      sessions: (byRole.get(r.id) ?? []).slice().sort(byArchivedAtDesc),
    }))
  if (orphans.length > 0) {
    sessionGroups.push({ role: null, sessions: orphans.slice().sort(byArchivedAtDesc) })
  }

  return { archivedRoles, sessionGroups }
}

/** 侧栏归档入口计数:归档区角色数(含删除未完成) + 独立归档会话数(角色归档的会话不重复计)。 */
export function countArchived(
  roles: readonly RoleSummary[],
  sessions: readonly SessionSummary[],
): number {
  const { archivedRoles, sessionGroups } = groupForArchive(roles, sessions)
  return (
    archivedRoles.length + sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0)
  )
}

/** 角色主挂载目录(展示/警示用);无挂载返回 null。 */
export function primaryMount(role: RoleSummary) {
  return role.mounts.find((m) => m.primary) ?? role.mounts[0] ?? null
}
