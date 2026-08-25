import { useState } from 'react'
import type { RoleSummary, SessionSummary } from '../../../shared/domain'
import { SessionRowMenu } from './SessionRowMenu'

/**
 * 角色下的会话列表(未归档,updatedAt 倒序由 grouping 保证)+ 空态 + 「＋新会话」。
 * 行内改名/行内删除二次确认沿用旧 SessionSidebar 的交互模式。
 * 行操作收进末尾「⋯」小菜单(SessionRowMenu),不再悬浮遮挡会话名;
 * 双击会话名也可进入行内改名(单击仍是打开会话)。
 */

interface RoleSessionListProps {
  readonly role: RoleSummary
  readonly sessions: readonly SessionSummary[]
  readonly activeSessionId: string | null
  readonly creatingSession: boolean
  readonly onOpenSession: (sessionId: string) => void
  readonly onCreateSession: (roleId: string) => void
  readonly onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  readonly onArchiveSession: (sessionId: string) => void
  readonly onDeleteSession: (sessionId: string) => void
}

export function RoleSessionList({
  role,
  sessions,
  activeSessionId,
  creatingSession,
  onOpenSession,
  onCreateSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: RoleSessionListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const legacy = role.kind === 'legacy-unresolved'
  // deleting/delete_failed 的角色不允许新建会话(卡头有状态标记)
  const lifecycleBlocked = role.lifecycle !== 'ready'

  const startRename = (session: SessionSummary) => {
    setDeletingId(null)
    setRenamingId(session.id)
    setRenameDraft(session.title)
  }

  const submitRename = async (sessionId: string) => {
    const title = renameDraft.trim()
    if (title === '') {
      setRenamingId(null)
      return
    }
    const ok = await onRenameSession(sessionId, title)
    if (ok) setRenamingId(null)
  }

  return (
    <div className="role-sessions">
      {legacy && <div className="role-empty-text legacy-hint">未找到文件夹的旧会话</div>}

      {sessions.length === 0 &&
        !legacy &&
        (lifecycleBlocked ? (
          <div className="role-empty">
            <div className="role-empty-text">这位伙伴还没开工</div>
          </div>
        ) : (
          <div className="role-empty">
            <div className="role-empty-text">这位伙伴还没开工</div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={creatingSession}
              onClick={() => onCreateSession(role.id)}
            >
              {creatingSession ? '正在开聊…' : '和他聊聊'}
            </button>
          </div>
        ))}

      {sessions.map((session) => {
        const isActive = session.id === activeSessionId
        if (deletingId === session.id) {
          return (
            <div key={session.id} className="delete-confirm">
              <div className="delete-confirm-text">
                把「{session.title}」删掉?本地记录会一起清掉。
              </div>
              <div className="delete-confirm-btns">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setDeletingId(null)
                    onDeleteSession(session.id)
                  }}
                >
                  删掉
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDeletingId(null)}
                >
                  先留着
                </button>
              </div>
            </div>
          )
        }
        if (renamingId === session.id) {
          return (
            <div key={session.id} className={isActive ? 'session-item active' : 'session-item'}>
              <input
                className="rename-input"
                value={renameDraft}
                autoFocus
                maxLength={60}
                aria-label="会话新名字"
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitRename(session.id)
                  }
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={() => void submitRename(session.id)}
              />
            </div>
          )
        }
        return (
          <div key={session.id} className="session-row">
            <button
              type="button"
              className={isActive ? 'session-item active' : 'session-item'}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onOpenSession(session.id)}
              onDoubleClick={() => startRename(session)}
            >
              <span className="session-title">{session.title}</span>
              <span className="session-meta"> · {session.messageCount} 条消息</span>
            </button>
            <SessionRowMenu
              session={session}
              onStartRename={startRename}
              onArchive={(id) => {
                setRenamingId(null)
                onArchiveSession(id)
              }}
              onRequestDelete={(id) => {
                setRenamingId(null)
                setDeletingId(id)
              }}
            />
          </div>
        )
      })}

      {!legacy && !lifecycleBlocked && sessions.length > 0 && (
        <button
          type="button"
          className="role-new-session"
          disabled={creatingSession}
          onClick={() => onCreateSession(role.id)}
        >
          {creatingSession ? '正在开聊…' : '＋ 新会话'}
        </button>
      )}
    </div>
  )
}
