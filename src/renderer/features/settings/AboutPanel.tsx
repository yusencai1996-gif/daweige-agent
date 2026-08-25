import type { UpdateState } from '../../../shared/domain/update'

interface AboutPanelProps {
  readonly appVersion: string
  readonly updateState: UpdateState
  readonly onCheckUpdate: () => void
  readonly onDownloadUpdate: () => void
  readonly onInstallUpdate: () => void
}

/**
 * 设置页「关于与更新」:应用信息 + 更新状态机渲染。
 * 状态机见 src/shared/domain/update.ts;错误内容直接用人话展示,不包装。
 */
export function AboutPanel({
  appVersion,
  updateState,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: AboutPanelProps) {
  return (
    <>
      <div className="cred-panel">
        <div className="cred-panel-title">大微阁</div>
        <div className="cred-panel-desc">版本 {appVersion} · 你的桌面干活助理</div>
      </div>

      <div className="cred-panel update-panel">
        <div className="cred-panel-title">更新</div>
        <UpdateBody
          state={updateState}
          onCheckUpdate={onCheckUpdate}
          onDownloadUpdate={onDownloadUpdate}
          onInstallUpdate={onInstallUpdate}
        />
      </div>
    </>
  )
}

function UpdateBody({
  state,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: {
  readonly state: UpdateState
  readonly onCheckUpdate: () => void
  readonly onDownloadUpdate: () => void
  readonly onInstallUpdate: () => void
}) {
  switch (state.status) {
    case 'idle':
      return (
        <>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" onClick={onCheckUpdate}>
              检查更新
            </button>
          </div>
          <div className="update-note">更新只在大微阁官方服务器下载,数据不会丢。</div>
        </>
      )
    case 'checking':
      return (
        <div className="settings-actions">
          <button type="button" className="btn btn-primary" disabled>
            检查中…
          </button>
        </div>
      )
    case 'up-to-date':
      return (
        <>
          <div className="update-status">已是最新版本({state.currentVersion})。</div>
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost" onClick={onCheckUpdate}>
              再检查一次
            </button>
          </div>
        </>
      )
    case 'available':
      return (
        <>
          <div className="update-status">
            发现新版本 <strong>{state.version}</strong>
          </div>
          <div className="update-version-compare">
            当前 {state.currentVersion} → 新版本 {state.version}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" onClick={onDownloadUpdate}>
              立即下载
            </button>
          </div>
        </>
      )
    case 'downloading': {
      const percent = Math.min(100, Math.max(0, Math.round(state.percent)))
      return (
        <>
          <div className="update-status">正在下载 {percent}%</div>
          <div
            className="update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`新版本 ${state.version} 下载进度`}
          >
            <div className="update-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </>
      )
    }
    case 'ready':
      return (
        <>
          <div className="update-status">
            新版本 <strong>{state.version}</strong> 已下载好。
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" onClick={onInstallUpdate}>
              重启完成升级
            </button>
          </div>
          <div className="update-note">也可以先继续用,退出时会自动装。</div>
        </>
      )
    case 'error':
      return (
        <>
          <div className="update-error" role="alert">
            {state.message}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost" onClick={onCheckUpdate}>
              重试
            </button>
          </div>
        </>
      )
    case 'dev-mode':
      return <div className="update-status">开发模式不支持更新。</div>
  }
}
