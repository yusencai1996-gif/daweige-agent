import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CollaborationPanelCollapsed } from './CollaborationPanelCollapsed'
import { CollaborationPanelExpanded } from './CollaborationPanelExpanded'
import {
  computeFlipTransform,
  isTerminalRunStatus,
  panelTransitionKind,
  resolvePanelView,
  type CollabPanelActions,
  type CollabPanelData,
  type CollabPanelView,
  type PanelRect,
} from './collab-panel-model'
import type { DelegationCardActions } from './DelegationCard'

/**
 * 协作链常驻面板外壳(A-28,PLAN §6.3/§6.5):挂在对话区右上角的 fixed 锚定容器,
 * 按数据态裁决三副形态(小窗/面板/详情),负责两件全局的事:
 *
 * 1. 共享时钟(PLAN §6.4-4):全面板只此一个 1s timer 驱动「已运行时长」,
 *    页面隐藏(document.hidden)时暂停;没有非终态节点时干脆不跑。
 * 2. FLIP 过渡(PLAN §6.5,用户硬要求流畅):不用动画库——三态切换时量新旧矩形,
 *    外壳只动画 transform+opacity(约 240ms),内容层延后淡入;
 *    新点击取消旧动画、从当前视觉矩形接续;prefers-reduced-motion 直接切状态;
 *    连线用语义化连接行不画 SVG,动画期间天然零重测。
 *
 * 面板只渲染 manager(小柊)会话:ChatView 只在 manager 会话挂它;无 run 时返回 null。
 * 面板数据/动作接口(CollabPanelData/CollabPanelActions)在 collab-panel-model.ts。
 */

interface CollaborationPanelHostProps {
  readonly data: CollabPanelData
  readonly actions: CollabPanelActions
  readonly delegation: DelegationCardActions
}

const FLIP_DURATION_MS = 240
const FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/** 单个共享时钟:active=false 不跑;页面隐藏暂停、回前台立刻补一拍。 */
function useSharedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    let interval: number | null = null
    const tick = () => setNow(Date.now())
    const start = () => {
      if (interval === null) interval = window.setInterval(tick, 1000)
    }
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval)
        interval = null
      }
    }
    tick()
    start()
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        tick()
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
  return now
}

function rectOf(el: HTMLElement): PanelRect {
  const r = el.getBoundingClientRect()
  return { top: r.top, right: r.right, width: r.width, height: r.height }
}

function sameRect(a: PanelRect, b: PanelRect): boolean {
  return (
    a.top === b.top && a.right === b.right && a.width === b.width && a.height === b.height
  )
}

export function CollaborationPanelHost({ data, actions, delegation }: CollaborationPanelHostProps) {
  const view: CollabPanelView | null =
    data.graph === null
      ? null
      : resolvePanelView({
          hasGraph: true,
          detailOpen: data.detailOpen,
          minimized: data.minimized,
          manualExpanded: data.manualExpanded,
          activeCount: data.graph.aggregate.active,
        })

  // 共享时钟只给「活着且在计时」的链跑;全终态/未启动的链不点表
  const needsClock =
    view !== null &&
    data.graph !== null &&
    data.graph.nodes.some((n) => n.startedAt !== null && !isTerminalRunStatus(n.status))
  const now = useSharedNow(needsClock)

  const shellRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  /** 上一帧布局矩形(FLIP 的 from);常态由 ResizeObserver 保持新鲜。 */
  const lastRectRef = useRef<PanelRect | null>(null)
  const prevViewRef = useRef<CollabPanelView | null>(null)

  /**
   * FLIP:视图切换后(布局已到位)量新矩形,把外壳先贴回旧矩形再动画回 identity。
   * transform-origin 右上 —— 锚点不动,小面板看起来像从详情页里「收」回去。
   */
  useLayoutEffect(() => {
    const el = shellRef.current
    if (el === null || view === null) {
      prevViewRef.current = view
      lastRectRef.current = null
      return
    }
    const viewChanged = prevViewRef.current !== null && prevViewRef.current !== view
    prevViewRef.current = view

    // 旧动画在飞:先取当前视觉矩形(含 transform)作 from,取消后从它接续,不闪跳
    const flying = el.getAnimations()
    let fromRect: PanelRect | null
    if (flying.length > 0) {
      fromRect = rectOf(el)
      for (const animation of flying) animation.cancel()
    } else {
      fromRect = lastRectRef.current
    }
    const toRect = rectOf(el)
    lastRectRef.current = toRect

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!viewChanged || panelTransitionKind(reduced) === 'instant') return
    if (fromRect === null || sameRect(fromRect, toRect)) return

    el.style.transformOrigin = 'top right'
    el.animate(
      [
        { transform: computeFlipTransform(fromRect, toRect), opacity: 0.55 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
    )
    // 内容层稍后淡入:外壳按最终尺寸一次性排版(transform 不触发布局),
    // MessageList 只排一次,不在动画期逐帧重排
    innerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      delay: 60,
      easing: FLIP_EASING,
      fill: 'backwards',
    })
  }, [view])

  // 内容尺寸变化(节点增减/时长换行)时刷新基准矩形;动画进行中跳过,结束后统一以最新为准
  useEffect(() => {
    const el = shellRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => {
      if (el.getAnimations().length > 0) return
      lastRectRef.current = rectOf(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [view])

  if (view === null || data.graph === null) return null
  const ready = { ...data, graph: data.graph }

  return (
    <div className={`collab-panel is-${view}`} ref={shellRef}>
      <div className="collab-panel-inner" ref={innerRef}>
        {view === 'detail' ? (
          <CollaborationPanelExpanded
            data={ready}
            actions={actions}
            now={now}
            delegation={delegation}
          />
        ) : (
          <CollaborationPanelCollapsed
            data={ready}
            actions={actions}
            now={now}
            mini={view === 'mini'}
          />
        )}
      </div>
    </div>
  )
}
