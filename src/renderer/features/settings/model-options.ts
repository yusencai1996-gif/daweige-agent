import type { ProviderSelection, Settings } from '../../../shared/domain'
import type { ModelOption } from '../../../shared/ipc/contracts'

/**
 * 设置页模型下拉(A-10)的纯逻辑:选项组装/文案格式化/选中回写。
 * 与渲染解耦,方便 MockBridge 驱动的单测直验链路。
 */

/** 下拉里的一项:在契约 ModelOption 上补一个「当前选中但不在列表里」的标记。 */
export interface ModelChoice extends ModelOption {
  /** true = 当前 settings 里选中的模型,但本次拉到的列表没有它(保留显示,防选中态丢失)。 */
  readonly current?: boolean
}

/** 上下文窗口人话:262144 → "26 万上下文";一万以下直接给数字;undefined → "上下文未知"。 */
export function formatContextWindow(contextWindow: number | undefined): string {
  if (contextWindow === undefined) return '上下文未知'
  if (contextWindow >= 10000) return `${Math.round(contextWindow / 10000)} 万上下文`
  return `${contextWindow} 上下文`
}

/** 下拉项文案:id + 上下文;本地默认列表(catalog)的项标「默认」;补位的当前项只标「当前」(它不在默认列表里,不能冒充「默认」)。 */
export function modelOptionLabel(option: ModelChoice): string {
  const badges: string[] = []
  if (option.current) badges.push('当前')
  else if (option.source === 'catalog') badges.push('默认')
  const suffix = badges.length > 0 ? ` · ${badges.join(' · ')}` : ''
  return `${option.id} · ${formatContextWindow(option.contextWindow)}${suffix}`
}

/**
 * 组装下拉选项:按 id 去重(在线与默认列表撞名时先到的赢);
 * 当前选中的模型不在列表里时,置顶补一项标「当前」,避免下拉选中态凭空跳走。
 */
export function buildModelOptions(
  models: readonly ModelOption[],
  currentModelId: string | null,
): readonly ModelChoice[] {
  const seen = new Set<string>()
  const options: ModelChoice[] = []
  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    options.push(model)
  }
  if (currentModelId !== null && !seen.has(currentModelId)) {
    return [{ id: currentModelId, source: 'catalog', current: true }, ...options]
  }
  return options
}

/** 选中即持久化:在现有 settings 上换 providerSelection(走 settings:update,不动契约)。 */
export function withProviderSelection(settings: Settings, selection: ProviderSelection): Settings {
  return { ...settings, providerSelection: selection }
}
