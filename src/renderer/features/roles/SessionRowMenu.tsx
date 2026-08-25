import type { SessionSummary } from '../../../shared/domain'
import { usePopupMenu } from './use-popup-menu'

/**
 * 会话行末的「⋯」操作钮 + 小菜单(改名/归档/删除;未分组行无改名)。
 * 交互复用 RoleCard 的 role-menu 模式(usePopupMenu):上下自适应展开、
 * Esc 关并焦点回触发钮、click-outside 关闭、打开时焦点进首项。
 * 样式复用 .role-menu / .role-menu-item;按钮显隐由 .session-menu-btn CSS 控制
 * (hover 行淡入,菜单打开期间 aria-expanded=true 保持可见)。
 */

/** 菜单大致高度(3 项 + 内边距),用于判断下方展开空间够不够。 */
const MENU_HEIGHT_GUESS = 120

interface SessionRowMenuProps {
  readonly session: SessionSummary
  /** 传入则菜单含「改名」项(行内编辑入口);不传(未分组行)则没有改名项。 */
  readonly onStartRename?: (session: SessionSummary) => void
  readonly onArchive: (sessionId: string) => void
  /** 点「删除」后的行内二次确认由调用方状态驱动。 */
  readonly onRequestDelete: (sessionId: string) => void
}

export function SessionRowMenu({
  session,
  onStartRename,
  onArchive,
  onRequestDelete,
}: SessionRowMenuProps) {
  const { menuOpen, menuUp, menuBtnRef, menuRef, closeMenu, toggleMenu } =
    usePopupMenu(MENU_HEIGHT_GUESS, { preferUp: true })

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

  return (
    <>
      <button
        ref={menuBtnRef}
        type="button"
        className="session-menu-btn"
        aria-label={`「${session.title}」的会话操作`}
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
      {menuOpen && (
        <div
          ref={menuRef}
          className={menuUp ? 'role-menu session-menu up' : 'role-menu session-menu'}
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              closeMenu(true) // Esc 后焦点回触发按钮
            }
          }}
        >
          {onStartRename !== undefined && menuItem('改名', () => onStartRename(session))}
          {menuItem('归档', () => onArchive(session.id))}
          {menuItem('删除', () => onRequestDelete(session.id), true)}
        </div>
      )}
    </>
  )
}
