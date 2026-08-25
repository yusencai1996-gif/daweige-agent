import type { ProviderId, ProviderInfo, ProviderSelection } from '../../../shared/domain'

interface ProviderSelectorProps {
  readonly providers: readonly ProviderInfo[]
  readonly selection: ProviderSelection
  readonly onSelect: (selection: ProviderSelection) => void
}

/** 输入框工具行的紧凑厂商下拉(只留一个 select,tooltip 显示完整模型名)。 */
export function ProviderSelector({ providers, selection, onSelect }: ProviderSelectorProps) {
  const current = providers.find((p) => p.id === selection.providerId)
  return (
    <select
      id="provider-select"
      className="provider-select"
      value={selection.providerId}
      title={current ? `${current.displayName} · ${selection.modelId}` : selection.modelId}
      aria-label="模型"
      onChange={(e) => {
        const provider = providers.find((p) => p.id === (e.target.value as ProviderId))
        if (!provider) return
        onSelect({ providerId: provider.id, modelId: provider.defaultModelId })
      }}
    >
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.displayName}
        </option>
      ))}
    </select>
  )
}
