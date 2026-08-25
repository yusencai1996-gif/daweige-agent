import type { DaweigeBridge } from '../../shared/ipc/bridge'
import sealUrl from '../assets/icon-seal.png'

/**
 * 自绘标题栏(titleBarStyle hidden 后系统标题栏退场,消除 Win11 系统蓝边)。
 * 整条可拖拽;右侧窗口控制经 IPC 由主进程执行(渲染进程无窗口 API)。
 * 双击拖拽区由 Electron 默认触发最大化切换。
 */

interface TitleBarProps {
  readonly bridge: DaweigeBridge
  /** 激活会话的标题(无会话时不显示会话信息)。 */
  readonly sessionTitle?: string | null
  /** 激活会话的工作文件夹路径(muted 小字,超长截断)。 */
  readonly workspacePath?: string | null
}

function sendWindowAction(bridge: DaweigeBridge, channel: 'window:minimize' | 'window:toggleMaximize' | 'window:close'): void {
  bridge.invoke(channel, undefined).catch(() => {
    // 窗口控制失败无用户可见副作用可补救;吞掉避免未处理拒绝
  })
}

export function TitleBar({ bridge, sessionTitle, workspacePath }: TitleBarProps) {
  return (
    <div className="titlebar" role="heading" aria-level={1}>
      <div className="titlebar-brand">
        <img className="titlebar-logo" src={sealUrl} alt="" aria-hidden="true" />
        <span>大微阁</span>
      </div>
      {sessionTitle ? (
        <div className="titlebar-session">
          <span className="titlebar-session-title">{sessionTitle}</span>
          {workspacePath && (
            <span className="titlebar-session-path" title={workspacePath}>
              {workspacePath}
            </span>
          )}
        </div>
      ) : (
        <div className="titlebar-spacer" aria-hidden="true" />
      )}
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最小化"
          onClick={() => sendWindowAction(bridge, 'window:minimize')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="1" y1="5.5" x2="9" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最大化或还原"
          onClick={() => sendWindowAction(bridge, 'window:toggleMaximize')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          aria-label="关闭"
          onClick={() => sendWindowAction(bridge, 'window:close')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
