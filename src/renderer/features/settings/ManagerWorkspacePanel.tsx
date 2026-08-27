import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManagerWorkspaceState } from '../../../shared/domain/manager-workspace'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A-14 总管工作区设置面板:展示小柊当前工作文件夹,支持整体迁移到自选位置。
 * 路径必须先经 workspace:choose 选择器授权,再走 managerWorkspace:migrate 专用通道;
 * 迁移把小柊的工作文件夹整体搬到新位置,搬完立即生效(会话绑定在下次启动收敛)。
 * 「恢复默认」同样走 migrate(默认路径);默认路径只在见过 isDefault=true 状态时可知,
 * 未知时按钮禁用并说明,绝不瞎猜路径。
 */
export function ManagerWorkspacePanel({ bridge }: { readonly bridge: DaweigeBridge }) {
  const [state, setState] = useState<ManagerWorkspaceState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultPathRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    bridge
      .invoke('managerWorkspace:get', undefined)
      .then((s) => {
        if (!alive) return
        setState(s)
        if (s.isDefault) defaultPathRef.current = s.effectivePath
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [bridge])

  const migrate = useCallback(
    async (targetPath: string) => {
      if (migrating) return
      setMigrating(true)
      setError(null)
      try {
        const next = await bridge.invoke('managerWorkspace:migrate', { targetPath })
        setState(next)
        if (next.isDefault) defaultPathRef.current = next.effectivePath
      } catch (e: unknown) {
        setError(errorText(e))
      } finally {
        setMigrating(false)
      }
    },
    [bridge, migrating],
  )

  const chooseAndMigrate = useCallback(async () => {
    if (migrating) return
    setError(null)
    try {
      // 先弹系统目录选择器;用户取消(null)就当没点过
      const chosen = await bridge.invoke('workspace:choose', undefined)
      if (chosen === null) return
      await migrate(chosen)
    } catch (e: unknown) {
      setError(errorText(e))
    }
  }, [bridge, migrate, migrating])

  if (loadError !== null) {
    return (
      <div className="workspace-panel">
        <div className="settings-desc">总管的工作文件夹状态没取到,请稍后再试。</div>
        <div className="test-result fail" role="alert">
          <span className="status-dot" aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-panel">
      <div className="settings-desc">
        这是小柊(总管)干活用的工作文件夹。迁移会把它整体搬到新位置,搬完立即生效;
        正在进行的会话绑定会在下次启动时收敛到位。
      </div>

      {state !== null && (
        <>
          <div className="workspace-current">
            <span className="form-label">当前工作文件夹</span>
            <code className="workspace-path">{state.effectivePath}</code>
            <div className="workspace-tags">
              <span className={state.isDefault ? 'workspace-tag' : 'workspace-tag migrated'}>
                {state.isDefault ? '内置默认位置' : '已迁移'}
              </span>
              {state.restartRequired && (
                <span className="workspace-tag">重启应用后完全生效</span>
              )}
            </div>
          </div>

          {state.cleanupWarning !== undefined && (
            <div className="workspace-warning" role="alert">
              {state.cleanupWarning}
            </div>
          )}

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={migrating}
              onClick={() => void chooseAndMigrate()}
            >
              {migrating ? '搬迁中…' : '选择文件夹并迁移'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={migrating || state.isDefault || defaultPathRef.current === null}
              title={
                defaultPathRef.current === null
                  ? '本次启动没见过默认位置,重启应用后即可恢复默认'
                  : undefined
              }
              onClick={() => {
                const fallback = defaultPathRef.current
                if (fallback !== null) void migrate(fallback)
              }}
            >
              恢复默认位置
            </button>
          </div>

          {error !== null && (
            <div className="test-result fail" role="alert">
              <span className="status-dot" aria-hidden="true" />
              <span>没搬成:{error}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
