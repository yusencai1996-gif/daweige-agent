import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 弹出小菜单(role-menu 模式)的通用状态与交互,RoleCard 卡头菜单与会话行 ⋯ 菜单共用:
 * - 打开前测量 .session-list 滚动容器上下空间,下方不够且上方更宽就向上展开(menuUp);
 * - 打开时焦点进首项;Esc 关闭并可把焦点还回触发按钮;
 * - document 级 mousedown click-outside 关闭(不用 fixed 遮罩——760px 抽屉态 sidebar
 *   带 transform,fixed 后代会被收进侧栏盒子而跑偏)。
 */

export interface PopupMenu {
  readonly menuOpen: boolean
  /** true = 菜单向上展开(配合 .role-menu.up)。 */
  readonly menuUp: boolean
  readonly menuBtnRef: React.RefObject<HTMLButtonElement | null>
  readonly menuRef: React.RefObject<HTMLDivElement | null>
  /** refocus=true 时把焦点还回触发按钮(Esc 关闭路径)。 */
  readonly closeMenu: (refocus: boolean) => void
  readonly toggleMenu: () => void
}

export function usePopupMenu(menuHeightGuess: number, options?: { preferUp?: boolean }): PopupMenu {
  // preferUp:默认向上展开(会话行菜单——往下必然压到「＋新会话」/列表底),顶部空间不足才向下
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuUp, setMenuUp] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false)
    if (refocus) menuBtnRef.current?.focus()
  }, [])

  const toggleMenu = useCallback(() => {
    setMenuOpen((open) => {
      if (!open) {
        // 打开前定方向:以 .session-list 滚动容器为界,下方不够且上方更宽就向上展开
        const btn = menuBtnRef.current
        if (btn) {
          const rect = btn.getBoundingClientRect()
          const container = btn.closest('.session-list')
          const cRect = container?.getBoundingClientRect()
          const below = (cRect?.bottom ?? window.innerHeight) - rect.bottom
          const above = rect.top - (cRect?.top ?? 0)
          if (options?.preferUp) {
            // 默认向上(往下会压「＋新会话」/列表底);仅上方连两行高都没有时回退向下
            setMenuUp(above >= 60)
          } else {
            setMenuUp(below < menuHeightGuess && above > below)
          }
        }
      }
      return !open
    })
  }, [menuHeightGuess, options?.preferUp])

  // 菜单打开期间:焦点移入首项;click-outside 关闭
  useEffect(() => {
    if (!menuOpen) return
    const first = menuRef.current?.querySelector<HTMLElement>('.role-menu-item')
    first?.focus({ preventScroll: true })
    const onDocPointerDown = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return
      closeMenu(false)
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [menuOpen, closeMenu])

  return { menuOpen, menuUp, menuBtnRef, menuRef, closeMenu, toggleMenu }
}
