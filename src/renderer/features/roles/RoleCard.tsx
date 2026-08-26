import { useEffect, useRef, useState } from 'react'
import type { RoleSummary, RoleTemplateId, SessionSummary } from '../../../shared/domain'
import { primaryMount } from './roles-grouping'
import { RoleSessionList } from './RoleSessionList'
import { usePopupMenu } from './use-popup-menu'

/**
 * 单角色卡(手风琴的一项):卡头(角色名+模板简称+会话数)+ 操作菜单 + 会话列表。
 * 当前会话所属角色:卡头左侧一枚克制的朱砂竖条。
 * lifecycle 非 ready(deleting/delete_failed):卡头标记状态,隐藏新建会话入口。
 */

/** 模板简称(卡头展示用)。 */
const TEMPLATE_SHORT: Record<RoleTemplateId, string> = {
  writer: '写稿',
  accountant: '会计',
  'file-steward': '管家',
  notebook: '记事',
  'legacy-empty': '旧档',
  'manager-built-in': '总管',
}

/** lifecycle 卡头标记文案;ready 不标记。 */
function lifecycleText(role: RoleSummary): string | null {
  if (role.lifecycle === 'deleting') return '删除中…'
  if (role.lifecycle === 'delete_failed') return '删除未完成(重启应用会继续)'
  return null
}

/** 菜单大致高度(4 项 + 内边距),用于判断下方展开空间够不够。 */
const MENU_HEIGHT_GUESS = 170

interface RoleCardProps {
  readonly role: RoleSummary
  readonly sessions: readonly SessionSummary[]
  readonly expanded: boolean
  /** 当前打开的会话属于这个角色(朱砂标记)。 */
  readonly containsActive: boolean
  readonly activeSessionId: string | null
  readonly creatingSession: boolean
  readonly onToggle: (roleId: string) => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onCreateSession: (roleId: string) => void
  readonly onRenameSession: (sessionId: string, title: string) => Promise<boolean>
  readonly onArchiveSession: (sessionId: string) => void
  readonly onDeleteSession: (sessionId: string) => void
  readonly onOpenRules: (roleId: string) => void
  readonly onRenameRole: (roleId: string, displayName: string) => Promise<boolean>
  readonly onArchiveRole: (roleId: string) => void
  readonly onDeleteRole: (role: RoleSummary) => void
}

export function RoleCard({
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
  onOpenRules,
  onRenameRole,
  onArchiveRole,
  onDeleteRole,
}: RoleCardProps) {
  const { menuOpen, menuUp, menuBtnRef, menuRef, closeMenu, toggleMenu } =
    usePopupMenu(MENU_HEIGHT_GUESS)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  const mountMissing = primaryMount(role)?.availability === 'missing'
  const lifecycle = lifecycleText(role)

  // 当前会话所属角色展开时,滚到可见区域
  useEffect(() => {
    if (expanded && containsActive) {
      cardRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [expanded, containsActive])

  const startRename = () => {
    closeMenu(false)
    setRenaming(true)
    setRenameDraft(role.displayName)
  }

  const submitRename = async () => {
    const name = renameDraft.trim()
    if (name === '' || name === role.displayName) {
      setRenaming(false)
      return
    }
    const ok = await onRenameRole(role.id, name)
    if (ok) setRenaming(false)
  }

  const menuItem = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      className={danger ? 'role-menu-item danger' : 'role-menu-item'}
      role="menuitem"
      onClick={() => {
        closeMenu(false)
        action()
      }}
    >
      {label}
    </button>
  )

  // 类型防御(0.3.0):manager 由 ManagerCard 专门渲染,走到这里是分组逻辑漏了,
  // 宁可不渲染也不能把总管当成普通 worker 卡(会带出改名/归档/删除角色等越权入口)
  if (role.kind === 'manager') return null

  return (
    <div
      ref={cardRef}
      className={`role-card${expanded ? ' expanded' : ''}${containsActive ? ' current' : ''}`}
    >
      <div className="role-card-head">
        {renaming ? (
          <input
            className="rename-input"
            value={renameDraft}
            autoFocus
            maxLength={24}
            aria-label="角色新名字"
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={() => void submitRename()}
          />
        ) : (
          <>
            <button
              type="button"
              className="role-card-title"
              aria-expanded={expanded}
              onClick={() => onToggle(role.id)}
            >
              <span className="role-name">
                {role.displayName}
                {mountMissing && (
                  <span
                    className="role-mount-warning"
                    role="img"
                    aria-label="工作文件夹不见了"
                    title="工作文件夹不见了,历史会话仍可看"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 4 2.5 20h19L12 4z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                      <path d="M12 10v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <circle cx="12" cy="16.8" r="0.9" fill="currentColor" />
                    </svg>
                  </span>
                )}
              </span>
              <span className="role-card-meta">
                {lifecycle !== null && (
                  <span
                    className={
                      role.lifecycle === 'delete_failed'
                        ? 'role-lifecycle failed'
                        : 'role-lifecycle'
                    }
                  >
                    {lifecycle}
                  </span>
                )}
                {/* 会话数取本地权威 sessions 的实时长度:role 摘要里的计数只在角色级 IPC 后刷新,会滞后 */}
                {TEMPLATE_SHORT[role.templateId]} · {sessions.length} 个会话
              </span>
            </button>
            <button
              ref={menuBtnRef}
              type="button"
              className="role-menu-btn"
              aria-label={`「${role.displayName}」的操作`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={toggleMenu}
              onKeyDown={(e) => {
                // 菜单开着时焦点在触发按钮上(罕见但可能),Esc 也要能关
                if (e.key === 'Escape' && menuOpen) {
                  e.stopPropagation()
                  closeMenu(false)
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="5.5" r="1.3" fill="currentColor" />
                <circle cx="12" cy="12" r="1.3" fill="currentColor" />
                <circle cx="12" cy="18.5" r="1.3" fill="currentColor" />
              </svg>
            </button>
          </>
        )}

        {menuOpen && (
          <div
            ref={menuRef}
            className={menuUp ? 'role-menu up' : 'role-menu'}
            role="menu"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                closeMenu(true) // Esc 后焦点回触发按钮
              }
            }}
          >
            {menuItem('编辑守则', () => void onOpenRules(role.id))}
            {menuItem('改名', startRename)}
            {/* 侧栏只渲染未归档角色(归档区才有「恢复」),这里恒为归档项 */}
            {menuItem('归档', () => void onArchiveRole(role.id))}
            {menuItem('删除', () => onDeleteRole(role), true)}
          </div>
        )}
      </div>

      {expanded && (
        <RoleSessionList
          role={role}
          sessions={sessions}
          activeSessionId={activeSessionId}
          creatingSession={creatingSession}
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
