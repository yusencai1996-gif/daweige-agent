import { useState } from 'react'
import type { RoleSummary, SessionSummary } from '../../../shared/domain'
import { countArchived, groupForSidebar } from './roles-grouping'
import { RoleCard } from './RoleCard'
import { SessionRowMenu } from './SessionRowMenu'

/**
 * 角色侧栏(0.2.0):品牌位 / 新建角色 / 角色卡片手风琴 / 归档入口 / 底部(使用统计+设置)。
 * 760px 以下沿用 sidebar.css 的抽屉机制(.sidebar / .sidebar-backdrop / .open)。
 */

interface RoleSidebarProps {
  readonly roles: readonly RoleSummary[]
  readonly sessions: readonly SessionSummary[]
  readonly activeSessionId: string | null
  readonly expandedRoleId: string | null
  readonly sessionBusy: boolean
  readonly open: boolean
  readonly notice: string | null
  /** 启动迁移失败的中文说明(bootstrap.migrationError);null=一切正常不显示。 */
  readonly migrationError: string | null
  readonly onClose: () => void
  readonly onToggleRole: (roleId: string) => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onCreateSession: (roleId: string) => void
  readonly onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  readonly onArchiveSession: (sessionId: string) => void
  readonly onDeleteSession: (sessionId: string) => void
  readonly onCreateRole: () => void
  readonly onOpenRules: (roleId: string) => void
  readonly onRenameRole: (roleId: string, displayName: string) => Promise<boolean>
  readonly onArchiveRole: (roleId: string) => void
  readonly onDeleteRole: (role: RoleSummary) => void
  readonly onOpenArchive: () => void
  readonly onOpenSettings: () => void
  readonly onOpenUsage: () => void
}

/** 未分组会话(roleId=null 防御组)行:点开 + 最小操作(归档/删除,行内二次确认)。 */
function UngroupedSessionRow({
  session,
  active,
  onOpen,
  onArchive,
  onDelete,
}: {
  readonly session: SessionSummary
  readonly active: boolean
  readonly onOpen: (sessionId: string) => void
  readonly onArchive: (sessionId: string) => void
  readonly onDelete: (sessionId: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="delete-confirm">
        <div className="delete-confirm-text">
          把「{session.title}」删掉?本地记录会一起清掉。
        </div>
        <div className="delete-confirm-btns">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setConfirming(false)
              onDelete(session.id)
            }}
          >
            删掉
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(false)}
          >
            先留着
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="session-row">
      <button
        type="button"
        className={active ? 'session-item active' : 'session-item'}
        onClick={() => onOpen(session.id)}
      >
        <span className="session-title">{session.title}</span>
        <span className="session-meta"> · {session.messageCount} 条消息</span>
      </button>
      <SessionRowMenu
        session={session}
        onArchive={onArchive}
        onRequestDelete={() => setConfirming(true)}
      />
    </div>
  )
}

export function RoleSidebar({
  roles,
  sessions,
  activeSessionId,
  expandedRoleId,
  sessionBusy,
  open,
  notice,
  migrationError,
  onClose,
  onToggleRole,
  onOpenSession,
  onCreateSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onCreateRole,
  onOpenRules,
  onRenameRole,
  onArchiveRole,
  onDeleteRole,
  onOpenArchive,
  onOpenSettings,
  onOpenUsage,
}: RoleSidebarProps) {
  const { roleGroups, ungroupedSessions } = groupForSidebar(roles, sessions)
  const archivedCount = countArchived(roles, sessions)
  // 空态与主列表口径一致(B-04):删除未完成的角色不算「还有角色」,它只在归档区出现
  const noRoles = roles.filter((r) => r.archivedAt === null && r.lifecycle === 'ready').length === 0
  const [migrationDismissed, setMigrationDismissed] = useState(false)

  return (
    <>
      {open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="收起角色列表"
          onClick={onClose}
        />
      )}
      <aside className={open ? 'sidebar open' : 'sidebar'} aria-label="角色与会话">
        <div className="sidebar-head">
          <div className="brand">大微阁</div>
          <div className="brand-sub">桌面干活助理</div>
        </div>

        <div className="sidebar-new">
          <button type="button" className="btn btn-primary" onClick={onCreateRole}>
            ＋ 新建角色
          </button>
        </div>

        {migrationError !== null && !migrationDismissed && (
          <div className="migration-banner" role="status">
            <span className="migration-banner-text">{migrationError}</span>
            <button
              type="button"
              className="migration-banner-close"
              aria-label="关闭这条提示"
              onClick={() => setMigrationDismissed(true)}
            >
              ×
            </button>
          </div>
        )}

        <div className="session-list" role="list">
          {noRoles && (
            <div className="role-empty-app">
              <div className="role-empty-app-title">先招一位伙伴吧</div>
              <div className="role-empty-app-text">
                每位伙伴守着一个文件夹,写稿、算账、收拾文件、记琐事,各干各的活儿。
              </div>
              <button type="button" className="btn btn-primary" onClick={onCreateRole}>
                新建角色
              </button>
            </div>
          )}

          {roleGroups.map(({ role, sessions: roleSessions }) => (
            <RoleCard
              key={role.id}
              role={role}
              sessions={roleSessions}
              expanded={expandedRoleId === role.id}
              containsActive={roleSessions.some((s) => s.id === activeSessionId)}
              activeSessionId={activeSessionId}
              creatingSession={sessionBusy}
              onToggle={onToggleRole}
              onOpenSession={(id) => {
                onOpenSession(id)
                onClose()
              }}
              onCreateSession={(roleId) => {
                onCreateSession(roleId)
                onClose()
              }}
              onRenameSession={onRenameSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              onOpenRules={onOpenRules}
              onRenameRole={onRenameRole}
              onArchiveRole={onArchiveRole}
              onDeleteRole={onDeleteRole}
            />
          ))}

          {ungroupedSessions.length > 0 && (
            <div className="role-card expanded ungrouped">
              <div className="role-card-head">
                <div className="role-card-title as-label">
                  <span className="role-name">未分组会话</span>
                </div>
              </div>
              <div className="role-sessions">
                {ungroupedSessions.map((session) => (
                  <UngroupedSessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    onOpen={(id) => {
                      onOpenSession(id)
                      onClose()
                    }}
                    onArchive={onArchiveSession}
                    onDelete={onDeleteSession}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`archive-entry${archivedCount === 0 ? ' empty' : ''}`}
          onClick={() => {
            onOpenArchive()
            onClose()
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 8h16M4 8v11h16V8M4 8l1.5-4h13L20 8M10 12h4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          归档 {archivedCount}
        </button>

        <div className="sidebar-foot">
          <span className="sidebar-notice" role="status">
            {notice ?? ''}
          </span>
          <div className="sidebar-foot-btns">
            <button
              type="button"
              className="sidebar-settings-btn"
              title="使用统计"
              onClick={onOpenUsage}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 20V10M10 20V4M16 20v-8M22 20H2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              使用统计
            </button>
            <button
              type="button"
              className="sidebar-settings-btn"
              title="设置"
              onClick={onOpenSettings}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              设置
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
