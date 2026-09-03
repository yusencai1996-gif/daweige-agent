import { useEffect, useRef, useState } from 'react'

interface MemoryClearDialogProps {
  /** 当前记忆总条数(打开弹层时的快照;分页场景为 total 而非已加载条数)。 */
  readonly count: number
  /** 确认清空:返回 ok=false 时弹层留在原地展示错误,允许重试。 */
  readonly onConfirm: () => Promise<{ readonly ok: boolean; readonly message?: string }>
  readonly onCancel: () => void
}

/** 弹层内可聚焦元素的选择器(禁用的不算,在途时退化为空集)。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 一键清空确认卡(0.6.0 F2;0.7.0 E-7 焦点闭环):
 * 写明条数和「会影响所有角色」;确认才调 memory:clear,取消不删。
 * 焦点闭环:打开时初始焦点在「先不清」;Tab/Shift+Tab 在弹层内循环,不落到
 * 弹层后面的页面;Escape 关闭;卸载时把焦点归还给打开它的按钮;清空在途时
 * 禁用所有按钮并拦下 Tab/Escape,防重复点击。
 */
export function MemoryClearDialog({ count, onConfirm, onCancel }: MemoryClearDialogProps) {
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  /** 清空在途时事件处理器看到的最新值(effect 闭包不依赖它)。 */
  const clearingRef = useRef(false)
  clearingRef.current = clearing

  // 打开:记下焦点来源(「一键清空」按钮),初始焦点放「先不清」;
  // 关闭:焦点归还来源元素(清空成功致其卸载时跳过,浏览器自然兜底)。
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      if (trigger !== null && trigger.isConnected) trigger.focus()
    }
  }, [])

  const confirm = async () => {
    if (clearing) return
    setClearing(true)
    setError(null)
    try {
      const result = await onConfirm()
      if (!result.ok) setError(result.message ?? '清空没有完成,可以重试。')
      // ok 时弹层由面板关闭
    } finally {
      setClearing(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // 清空在途时与按钮禁用保持一致:不允许中途关弹层
      if (!clearingRef.current) onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (focusables.length === 0) {
      // 在途时所有按钮禁用:焦点无处可去,拦下 Tab 防止落到弹层背后
      e.preventDefault()
      return
    }
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const active = document.activeElement
    const inside = active !== null && dialog.contains(active)
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="memory-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="清空全部记忆"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="memory-dialog-title">清空全部记忆?</div>
        <div className="memory-dialog-body">
          <p>
            将删除全部 <strong>{count}</strong> 条记忆,会影响所有角色;删了之后找不回来。
          </p>
          <p className="memory-dialog-muted">单个删除不需要确认卡,这里只拦「一键清空」。</p>
          {error !== null && (
            <div className="memory-dialog-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="memory-dialog-foot">
          <button
            type="button"
            ref={cancelRef}
            className="btn btn-ghost btn-sm"
            disabled={clearing}
            onClick={onCancel}
          >
            先不清
          </button>
          <span className="memory-dialog-foot-gap" />
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={clearing}
            onClick={() => void confirm()}
          >
            {clearing ? '正在清空…' : '确认清空'}
          </button>
        </div>
      </div>
    </div>
  )
}
