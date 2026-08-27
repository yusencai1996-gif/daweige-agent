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

/** 启用池(常用模型)容量上限;与 IPC schema 的 enabledModels maxItems 对齐。 */
export const ENABLED_MODELS_MAX = 32

/** 同一个模型的判定:厂商 + 模型 id 都一致才算同一项。 */
function sameModel(a: ProviderSelection, b: ProviderSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/**
 * 切换某模型在启用池中的勾选态:
 * 已在池中=移出(顺带清掉旧数据可能存在的重复条目);不在=追加。
 * 池已满(32 项)时返回原 settings 不变——IPC 会拒超限载荷,UI 不发徒劳请求。
 */
export function toggleEnabledModel(settings: Settings, item: ProviderSelection): Settings {
  const current = settings.enabledModels ?? []
  const rest = current.filter((m) => !sameModel(m, item))
  if (rest.length !== current.length) return { ...settings, enabledModels: rest }
  if (rest.length >= ENABLED_MODELS_MAX) return settings
  return { ...settings, enabledModels: [...rest, item] }
}

/**
 * 当前生效的启用池:未设置/为空(老数据)回退为只剩「当前选择」一项,
 * 对话区模型选择器不至于两手空空。
 */
export function effectiveEnabledModels(settings: Settings): readonly ProviderSelection[] {
  const pool = settings.enabledModels ?? []
  return pool.length > 0 ? pool : [settings.providerSelection]
}
