import { useState } from 'react'
import type { RoleSummary, SessionSummary } from '../../../shared/domain'
import { groupForArchive } from './roles-grouping'

/**
 * 归档区整页(MainPane,双页签):
 * - 角色页签:归档角色列表,可恢复/彻底删除;
 *   删除未完成(deleting/delete_failed)的角色也归这里(B-04):
 *   不显示「恢复」(恢复无意义);deleting 禁一切操作等续跑;delete_failed 保留「彻底删除」即重试入口。
 * - 会话页签:独立归档会话按角色分组(角色整体归档的会话不重复列),可恢复/彻底删除。
 * 整体弱化(muted)但保持可读。
 */

interface ArchiveViewProps {
  readonly roles: readonly RoleSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly onBack: () => void
  readonly onRestoreRole: (roleId: string) => void
  readonly onDeleteRole: (role: RoleSummary) => void
  readonly onRestoreSession: (sessionId: string) => void
  readonly onDeleteSession: (sessionId: string) => void
}

function formatArchivedAt(ts: number | null): string {
  if (ts === null) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** lifecycle 非 ready 的标记文案;ready 返回 null 不显示。 */
function lifecycleText(role: RoleSummary): string | null {
  if (role.lifecycle === 'deleting') return '删除中…'
  if (role.lifecycle === 'delete_failed') return '删除未完成(重启应用会继续)'
  return null
}

export function ArchiveView({
  roles,
  sessions,
  onBack,
  onRestoreRole,
  onDeleteRole,
  onRestoreSession,
  onDeleteSession,
}: ArchiveViewProps) {
  const [tab, setTab] = useState<'roles' | 'sessions'>('roles')
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)

  const { archivedRoles, sessionGroups } = groupForArchive(roles, sessions)
  const archivedSessionCount = sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0)

  return (
    <div className="archive-pane">
      <div className="archive-header">
        <div className="archive-header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            ‹ 返回
          </button>
          <h2 className="archive-title">归档</h2>
        </div>
        <div className="archive-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'roles'}
            className={tab === 'roles' ? 'archive-tab selected' : 'archive-tab'}
            onClick={() => setTab('roles')}
          >
            角色 {archivedRoles.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sessions'}
            className={tab === 'sessions' ? 'archive-tab selected' : 'archive-tab'}
            onClick={() => setTab('sessions')}
          >
            会话 {archivedSessionCount}
          </button>
        </div>
      </div>

      <div className="archive-body">
        {tab === 'roles' &&
          (archivedRoles.length === 0 ? (
            <div className="archive-empty muted">没有归档的角色。</div>
          ) : (
            archivedRoles.map((role) => (
              <div key={role.id} className="archive-row">
                <div className="archive-row-main">
                  <span className="archive-row-title">{role.displayName}</span>
                  <span className="archive-row-meta muted">
                    {role.sessionCount} 个会话
                    {role.archivedAt !== null && ` · 归档于 ${formatArchivedAt(role.archivedAt)}`}
                    {lifecycleText(role) !== null && (
                      <span
                        className={
                          role.lifecycle === 'delete_failed'
                            ? 'role-lifecycle failed'
                            : 'role-lifecycle'
                        }
                      >
                        {' '}
                        · {lifecycleText(role)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="archive-row-actions">
                  {role.lifecycle === 'ready' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onRestoreRole(role.id)}
                    >
                      恢复
                    </button>
                  )}
                  {/* delete_failed:彻底删除即重试(role:delete 幂等续跑);deleting:禁用等删除跑完 */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    disabled={role.lifecycle === 'deleting'}
                    onClick={() => onDeleteRole(role)}
                  >
                    彻底删除
                  </button>
                </div>
              </div>
            ))
          ))}

        {tab === 'sessions' &&
          (sessionGroups.length === 0 ? (
            <div className="archive-empty muted">没有单独归档的会话。</div>
          ) : (
            sessionGroups.map((group) => (
              <div key={group.role?.id ?? 'orphan'} className="archive-group">
                <div className="archive-group-title muted">
                  {group.role ? group.role.displayName : '未分组会话'}
                </div>
                {group.sessions.map((session) =>
                  deletingSessionId === session.id ? (
                    <div key={session.id} className="delete-confirm">
                      <div className="delete-confirm-text">
                        把「{session.title}」彻底删掉?本地记录会一起清掉。
                      </div>
                      <div className="delete-confirm-btns">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => {
                            setDeletingSessionId(null)
                            onDeleteSession(session.id)
                          }}
                        >
                          删掉
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDeletingSessionId(null)}
                        >
                          先留着
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={session.id} className="archive-row">
                      <div className="archive-row-main">
                        <span className="archive-row-title">{session.title}</span>
                        <span className="archive-row-meta muted">
                          {session.messageCount} 条消息 · 归档于{' '}
                          {formatArchivedAt(session.archivedAt)}
                        </span>
                      </div>
                      <div className="archive-row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onRestoreSession(session.id)}
                        >
                          恢复
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm danger"
                          onClick={() => setDeletingSessionId(session.id)}
                        >
                          彻底删除
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))
          ))}
      </div>
    </div>
  )
}
