import type { RoleSummary, SessionSummary } from '../../../shared/domain'
import { RoleSessionList } from '../roles/RoleSessionList'

/**
 * 总管卡(0.3.0):侧栏固定置顶的特殊卡,在「新建角色」按钮下方、普通角色组上方,
 * 不参与普通角色排序(roles-grouping 已显式过滤 kind==='manager')。
 * 与普通 RoleCard 的差异:
 * - 卡面带一枚克制的朱砂小印「总管」,没有角色级「⋯」菜单
 *   (不出现改名/守则/归档角色/删除角色/挂载目录任何入口);
 * - 会话列表复用 RoleSessionList,打开/重命名/归档/删除单条会话的能力与伙伴卡一致;
 * - 「＋ 新对话」走 session:create,roleId 即内置总管 ID(schema 已放开该字面量)。
 */

interface ManagerCardProps {
  /** kind==='manager' 的内置总管角色(小柊)。 */
  readonly role: RoleSummary
  /** 总管名下的未归档会话(updatedAt 倒序,由侧栏排好)。 */
  readonly sessions: readonly SessionSummary[]
  readonly expanded: boolean
  /** 当前打开的会话是总管会话(卡头左侧朱砂竖条)。 */
  readonly containsActive: boolean
  readonly activeSessionId: string | null
  readonly creatingSession: boolean
  readonly onToggle: (roleId: string) => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onCreateSession: (roleId: string) => void
  readonly onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  readonly onArchiveSession: (sessionId: string) => void
  readonly onDeleteSession: (sessionId: string) => void
}

export function ManagerCard({
  role,
  sessions,
  expanded,
  containsActive,
  activeSessionId,
  creatingSession,
  onToggle,
  onOpenSession,
  onCreateSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: ManagerCardProps) {
  return (
    <div
      className={`role-card manager-card${expanded ? ' expanded' : ''}${containsActive ? ' current' : ''}`}
    >
      <div className="role-card-head">
        <button
          type="button"
          className="role-card-title"
          aria-expanded={expanded}
          onClick={() => onToggle(role.id)}
        >
          <span className="role-name">
            {role.displayName}
            <span className="manager-seal">总管</span>
          </span>
          <span className="role-card-meta">总管 · {sessions.length} 个会话</span>
        </button>
      </div>

      {expanded && (
        <RoleSessionList
          role={role}
          sessions={sessions}
          activeSessionId={activeSessionId}
          creatingSession={creatingSession}
          labels={{
            emptyText: '还没有和小柊的对话',
            emptyCreateLabel: '＋ 新对话',
            createLabel: '＋ 新对话',
            busyLabel: '正在开聊…',
          }}
          onOpenSession={onOpenSession}
          onCreateSession={onCreateSession}
          onRenameSession={onRenameSession}
          onArchiveSession={onArchiveSession}
          onDeleteSession={onDeleteSession}
        />
      )}
    </div>
  )
}
