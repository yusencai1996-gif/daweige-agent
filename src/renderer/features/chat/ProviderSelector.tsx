import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProviderInfo, ProviderSelection } from '../../../shared/domain'

interface ProviderSelectorProps {
  readonly providers: readonly ProviderInfo[]
  readonly selection: ProviderSelection
  /** 启用池(settings.enabledModels);undefined/空=老数据,面板回退只显示当前一项并引导去设置页。 */
  readonly enabledModels?: readonly ProviderSelection[] | undefined
  readonly onSelect: (selection: ProviderSelection) => void
  /**
   * 「存为该角色默认」入口(A-24):当前会话属于某个角色(含小柊)时才出现;
   * 当前选择不在显式启用池时禁用并提示先入池。无角色会话(undefined)不渲染。
   */
  readonly saveAsRoleDefault?: {
    readonly roleName: string
    readonly canSave: boolean
    readonly onSave: () => void
  }
}

/** 对话区右下角模型选择器:按钮显示当前模型 id,点击向上弹出「启用池」面板(按厂商分组)。 */
export function ProviderSelector({ providers, selection, enabledModels, onSelect, saveAsRoleDefault }: ProviderSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const current = providers.find((p) => p.id === selection.providerId)

  // 老数据(池空/undefined)回退:只认当前选择一项,不给空面板。
  const hasPool = enabledModels !== undefined && enabledModels.length > 0
  const pool = hasPool ? enabledModels : [selection]

  // 按厂商分好组(保持池内出现顺序);厂商名从 providers 取,不在列表的兜底显示 id 本身。
  const groups = useMemo(() => {
    const byProvider = new Map<ProviderId, ProviderSelection[]>()
    for (const item of pool) {
      const bucket = byProvider.get(item.providerId)
      if (bucket !== undefined) bucket.push(item)
      else byProvider.set(item.providerId, [item])
    }
    const ordered = providers
      .filter((p) => byProvider.has(p.id))
      .map((p) => ({ key: p.id, name: p.displayName, items: byProvider.get(p.id)! }))
    const orphans = [...byProvider.entries()]
      .filter(([id]) => !providers.some((p) => p.id === id))
      .map(([id, items]) => ({ key: id, name: id, items }))
    return [...ordered, ...orphans]
  }, [pool, providers])

  // 点外面收起;Esc 也收起(挂在 window 上,面板内焦点不丢监听)。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = (item: ProviderSelection) => {
    setOpen(false)
    onSelect(item)
  }

  return (
    <div className="model-switch" ref={rootRef}>
      <button
        type="button"
        id="provider-select"
        className="model-switch-btn"
        title={current ? `${current.displayName} · ${selection.modelId}` : selection.modelId}
        aria-label="模型"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-switch-model">{selection.modelId}</span>
        <svg
          className="model-switch-caret"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path d="M2 6.4l3-3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        // 不声明 listbox/menu 语义:未实现方向键导航,声明了反而误导辅助技术;按钮列表 Tab 天然可达
        <div className="model-switch-panel" aria-label="切换模型">
          {!hasPool && (
            <div className="model-switch-guide">去设置页勾选常用模型</div>
          )}
          {groups.map((group) => (
            <Fragment key={group.key}>
              <div className="model-switch-group">{group.name}</div>
              {group.items.map((item) => {
                const isCurrent =
                  item.providerId === selection.providerId && item.modelId === selection.modelId
                return (
                  <button
                    key={`${item.providerId}:${item.modelId}`}
                    type="button"
                    aria-pressed={isCurrent}
                    className={isCurrent ? 'model-switch-item current' : 'model-switch-item'}
                    onClick={() => pick(item)}
                  >
                    <span>{item.modelId}</span>
                    {isCurrent && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path
                          d="M2.2 6.4l2.6 2.6L9.8 3"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                )
              })}
            </Fragment>
          ))}
          {saveAsRoleDefault !== undefined && (
            <div className="model-switch-save">
              <button
                type="button"
                className="model-switch-save-btn"
                disabled={!saveAsRoleDefault.canSave}
                onClick={() => {
                  setOpen(false)
                  saveAsRoleDefault.onSave()
                }}
              >
                存为「{saveAsRoleDefault.roleName}」的默认
              </button>
              {!saveAsRoleDefault.canSave && (
                <div className="model-switch-save-tip">当前模型不在常用池,先到设置页勾选入池</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
