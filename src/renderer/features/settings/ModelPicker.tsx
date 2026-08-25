import { useState } from 'react'
import type { ProviderInfo, ProviderSelection } from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import { buildModelOptions, modelOptionLabel, type ModelChoice } from './model-options'
import type { ModelOption } from '../../../shared/ipc/contracts'

interface ModelSelectProps {
  readonly options: readonly ModelChoice[]
  readonly value: string
  readonly ariaLabel: string
  readonly onChange: (modelId: string) => void
}

/** 纯展示下拉(无副作用,单测可直接静态渲染核对选项文案)。 */
export function ModelSelect({ options, value, ariaLabel, onChange }: ModelSelectProps) {
  return (
    <select
      className="text-input model-select"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {modelOptionLabel(option)}
        </option>
      ))}
    </select>
  )
}

interface ModelPickerProps {
  readonly bridge: DaweigeBridge
  readonly provider: ProviderInfo
  /** 该厂商是否已保存 key;未保存时「获取模型列表」禁用。 */
  readonly configured: boolean
  /** 全局当前选择(settings.providerSelection);属于本厂商时作为下拉选中值。 */
  readonly selection: ProviderSelection
  /** 选中/手动输入即调用(内部走 settings:update 持久化,顶部模型切换跟随)。 */
  readonly onSelectProvider: (selection: ProviderSelection) => void
}

/**
 * 厂商面板里的模型选择(A-10):
 * 填完 key → 「获取模型列表」拉 credential:listModels → 下拉选中即写回 settings.providerSelection.modelId。
 * 下拉旁保留「手动输入」小入口,在线拉取失败且默认列表没有目标模型时不卡死。
 */
export function ModelPicker({
  bridge,
  provider,
  configured,
  selection,
  onSelectProvider,
}: ModelPickerProps) {
  const [loading, setLoading] = useState(false)
  const [models, setModels] = useState<readonly ModelOption[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualDraft, setManualDraft] = useState('')

  // 本厂商的当前模型:全局选择正挂着这家就用它,否则以该厂默认模型占位。
  // 选项渲染期派生:手动输入/别处置入的模型不在列表里时,自动补「当前」项,选中态不丢。
  const currentModelId =
    selection.providerId === provider.id ? selection.modelId : provider.defaultModelId
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
          <>
            <ModelSelect
              options={options}
              value={currentModelId}
              ariaLabel={`${provider.displayName} 模型`}
              onChange={choose}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setManualOpen((v) => !v)}
            >
              手动输入
            </button>
          </>
        )}
      </div>
      {options === null && !error && (
        <div className="form-tip">
          {configured
            ? '点「获取模型列表」从厂里拉可选模型;列表里没有的也可以手动输入。'
            : '先在上面保存 key,再拉模型列表。'}
        </div>
      )}
      {notice && <div className="form-tip model-notice">{notice}</div>}
      {error && (
        <div className="test-result fail" role="alert">
          <span className="status-dot" aria-hidden="true" />
          <span>模型列表没拉成:{error}</span>
        </div>
      )}
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
    </div>
  )
}
