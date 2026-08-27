import { useState } from 'react'
import type { ProviderId, ProviderInfo, ProviderSelection } from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import {
  buildModelOptions,
  ENABLED_MODELS_MAX,
  formatContextWindow,
  type ModelChoice,
} from './model-options'
import type { ModelOption } from '../../../shared/ipc/contracts'

/**
 * 纯展示清单(无副作用,单测可直接静态渲染核对行文案与勾选态)。
 * 每行两个控件语义分开:勾选框=进出「启用池」;点名字=设为「当前使用」。
 */
interface ModelCheckboxListProps {
  readonly options: readonly ModelChoice[]
  /** 该厂商 id(勾选/选当前时拼成 ProviderSelection 写回)。 */
  readonly providerId: ProviderId
  /** 全局当前模型的 modelId,对应行加粗标「当前」。 */
  readonly currentModelId: string
  /** 全局当前选择是否正挂在本厂商:非本厂商时本清单无「当前」行(默认模型只标「默认」,防误读)。 */
  readonly currentLive: boolean
  /** 启用池现状,决定勾选框 checked 与池满禁用。 */
  readonly enabledModels: readonly ProviderSelection[]
  readonly ariaLabel: string
  readonly onChoose: (modelId: string) => void
  readonly onToggle: (modelId: string) => void
}

export function ModelCheckboxList({
  options,
  providerId,
  currentModelId,
  currentLive,
  enabledModels,
  ariaLabel,
  onChoose,
  onToggle,
}: ModelCheckboxListProps) {
  const enabledIds = new Set(
    enabledModels.filter((m) => m.providerId === providerId).map((m) => m.modelId),
  )
  const poolFull = enabledModels.length >= ENABLED_MODELS_MAX
  return (
    <ul className="model-checklist" aria-label={ariaLabel}>
      {options.map((option) => {
        const isCurrent = currentLive && option.id === currentModelId
        const inPool = enabledIds.has(option.id)
        return (
          <li key={option.id} className={isCurrent ? 'model-check-item current' : 'model-check-item'}>
            <input
              type="checkbox"
              className="model-check-box"
              checked={inPool}
              disabled={!inPool && poolFull}
              title={
                poolFull && !inPool
                  ? `启用池最多 ${ENABLED_MODELS_MAX} 个`
                  : inPool
                    ? '取消勾选,移出启用池'
                    : '勾选加入启用池,对话区就能直接切'
              }
              aria-label={`启用模型 ${option.id}`}
              onChange={() => onToggle(option.id)}
            />
            <button
              type="button"
              className="model-check-main"
              onClick={() => onChoose(option.id)}
              title={`把回复换成 ${option.id}`}
            >
              <span className="model-check-label">{option.id}</span>
              <span className="model-check-meta">{formatContextWindow(option.contextWindow)}</span>
              {option.source === 'catalog' && !isCurrent && <span className="model-tag">默认</span>}
            </button>
            {isCurrent && <span className="model-tag current">当前</span>}
          </li>
        )
      })}
    </ul>
  )
}

interface ModelPickerProps {
  readonly bridge: DaweigeBridge
  readonly provider: ProviderInfo
  /** 该厂商是否已保存 key;未保存时「获取模型列表」禁用。 */
  readonly configured: boolean
  /** 全局当前选择(settings.providerSelection);属于本厂商时作为「当前」标记依据。 */
  readonly selection: ProviderSelection
  /** 启用池(settings.enabledModels),勾选框的勾选态与池满判定数据源。 */
  readonly enabledModels: readonly ProviderSelection[]
  /** 选中/手动输入即调用(写 settings.providerSelection 持久化,对话区模型跟随)。 */
  readonly onSelectProvider: (selection: ProviderSelection) => void
  /** 勾选/取消一个常用模型即调用(写 settings.enabledModels 持久化)。 */
  readonly onToggleEnabledModel: (item: ProviderSelection) => void
}

/**
 * 厂商面板里的模型选择(A-10 改版):
 * 填完 key → 「获取模型列表」拉 credential:listModels → 清单里:
 * 勾选框管「启用进池」(settings.enabledModels,对话区可切的家底),
 * 点名字管「当前使用」(settings.providerSelection);两个动作不混在一个控件上。
 * 名字旁保留「手动输入」小入口,在线拉取失败且默认列表没有目标模型时不卡死。
 */
export function ModelPicker({
  bridge,
  provider,
  configured,
  selection,
  enabledModels,
  onSelectProvider,
  onToggleEnabledModel,
}: ModelPickerProps) {
  const [loading, setLoading] = useState(false)
  const [models, setModels] = useState<readonly ModelOption[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualDraft, setManualDraft] = useState('')

  // 本厂商的当前模型:全局选择正挂着这家就用它,否则以该厂默认模型占位(仅预选,不标「当前」)。
  // 清单渲染期派生:手动输入/别处置入的模型不在列表里时,自动补一行(本厂商时带「当前」标记,选中态不丢)。
  const currentLive = selection.providerId === provider.id
  const currentModelId = currentLive ? selection.modelId : provider.defaultModelId
  const options = models === null ? null : buildModelOptions(models, currentModelId)

  const load = async () => {
    if (loading || !configured) return
    setLoading(true)
    setError(null)
    try {
      const result = await bridge.invoke('credential:listModels', { providerId: provider.id })
      setModels(result.models)
      setNotice(result.notice ?? null)
    } catch (err) {
      setModels(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const choose = (modelId: string) => {
    onSelectProvider({ providerId: provider.id, modelId })
  }

  const toggle = (modelId: string) => {
    onToggleEnabledModel({ providerId: provider.id, modelId })
  }

  const applyManual = () => {
    const modelId = manualDraft.trim()
    if (modelId === '') return
    choose(modelId)
    setManualDraft('')
    setManualOpen(false)
  }

  return (
    <div className="model-area">
      <div className="form-label">模型</div>
      <div className="model-row">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void load()}
          disabled={loading || !configured}
          title={configured ? undefined : '先保存 key 才能拉模型列表'}
        >
          {loading ? '正在拉模型列表…' : options !== null ? '重新获取模型列表' : '获取模型列表'}
        </button>
        {options !== null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setManualOpen((v) => !v)}
          >
            手动输入
          </button>
        )}
        {options !== null && (
          <span className="form-tip model-count">
            已入池 {enabledModels.length}/{ENABLED_MODELS_MAX}
          </span>
        )}
      </div>
      {options === null && !error && (
        <div className="form-tip">
          {configured
            ? '点「获取模型列表」从厂里拉可选模型;列表里没有的也可以手动输入。'
            : '先在上面保存 key,再拉模型列表。'}
        </div>
      )}
      {options !== null && (
        <div className="form-tip">
          点名字=用它回复;勾左边框=收进常用池,对话区右下角就能直接换。
        </div>
      )}
      {notice && <div className="form-tip model-notice">{notice}</div>}
      {error && (
        <div className="test-result fail" role="alert">
          <span className="status-dot" aria-hidden="true" />
          <span>模型列表没拉成:{error}</span>
        </div>
      )}
      {options !== null && (
        <>
          <ModelCheckboxList
            options={options}
            providerId={provider.id}
            currentModelId={currentModelId}
            currentLive={currentLive}
            enabledModels={enabledModels}
            ariaLabel={`${provider.displayName} 模型`}
            onChoose={choose}
            onToggle={toggle}
          />
          {manualOpen && (
            <div className="model-manual">
              <input
                type="text"
                className="text-input"
                value={manualDraft}
                placeholder="填模型 id,比如 glm-4.7"
                aria-label={`${provider.displayName} 模型 id`}
                onChange={(e) => setManualDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyManual()
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={applyManual}
                disabled={manualDraft.trim() === ''}
              >
                用这个模型
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
