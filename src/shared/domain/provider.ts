/**
 * Provider(模型厂商)领域模型。
 *
 * ProviderId 与 pi 0.84.2 内置 provider id 保持一致:
 * - kimi-coding  (KIMI_API_KEY, anthropic-messages)
 * - zai          (ZAI_API_KEY, openai-completions, 国际)
 * - zai-coding-cn (ZAI_CODING_CN_API_KEY, openai-completions, 国内)
 * - deepseek     (DEEPSEEK_API_KEY, openai-completions)
 *
 * 铁律:渲染进程永远拿不到完整 API key,只能拿到 CredentialStatus(掩码)。
 */

export const PROVIDER_IDS = ['kimi-coding', 'zai', 'zai-coding-cn', 'deepseek'] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** 供 UI 下拉展示的厂商信息。defaultModelId 由 M3-01 锁定后写死。 */
export interface ProviderInfo {
  readonly id: ProviderId
  readonly displayName: string
  readonly defaultModelId: string
  readonly description: string
  /** 默认模型是否支持思考强度调节(pi Model.reasoning;不支持则 UI 隐藏该控件)。 */
  readonly supportsThinking: boolean
  /** 默认模型上下文窗口(pi Model.contextWindow),上下文用量环的分母。 */
  readonly contextWindow: number
}

/** 当前选中的厂商+模型(会话与全局设置都用它)。 */
export interface ProviderSelection {
  readonly providerId: ProviderId
  readonly modelId: string
}

/**
 * 凭据状态——渲染进程可见的全部信息。
 * configured=true 时只有打码掩码(如 "sk-****abcd"),绝不出现完整 key。
 * ephemeral=true 表示系统加密不可用,只在本次运行内有效,关闭后需重填。
 */
export type CredentialStatus =
  | { readonly providerId: ProviderId; readonly configured: false }
  | {
      readonly providerId: ProviderId
      readonly configured: true
      /** 打码显示,如 "sk-****abcd";只含头尾片段,不足以还原 key。 */
      readonly maskedKey: string
      /** true = 未加密、仅内存(系统加密暂不可用),关闭应用后需重新填写。 */
      readonly ephemeral?: boolean
    }
