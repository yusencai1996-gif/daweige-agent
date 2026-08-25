import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 悬浮卡显隐节奏(A-09):进入区域后延迟 showDelay ms 才显示——
 * 快速划过不产生闪现;区域内移动不重新计时(位置实时更新,显隐只此一处);
 * 离开区域立即隐藏。组件卸载自动清理定时器。
 */
export function useHoverDelay(showDelay = 70): {
  readonly visible: boolean
  /** 进入/在区域内移动时调用;已显示或已计时中则空操作。 */
  readonly arm: () => void
  /** 离开区域:立即隐藏并取消计时。 */
  readonly hide: () => void
} {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const arm = useCallback(() => {
    if (visible || timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setVisible(true)
    }, showDelay)
  }, [visible, showDelay])

  const hide = useCallback(() => {
    clear()
    setVisible(false)
  }, [clear])

  useEffect(() => clear, [clear])

  return { visible, arm, hide }
}
