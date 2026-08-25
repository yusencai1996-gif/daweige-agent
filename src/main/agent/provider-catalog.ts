/**
 * 厂商目录(应用层)。
 * ZAI 默认模型:pi 0.84.2 静态目录两区一致;live test 不通过时回退 glm-5.2/glm-4.7(R-03)。
 */
import type { ProviderId } from '../../shared/domain/provider'
import type { ProviderInfo } from '../../shared/domain/provider'

export const PROVIDER_CATALOG: readonly ProviderInfo[] = [
  {
    id: 'kimi-coding',
    displayName: 'Kimi',
    defaultModelId: 'kimi-for-coding',
    description: 'Kimi Coding Plan',
    // pi 0.84.2 静态模型表:kimi-for-coding reasoning=true, ctx=262144
    supportsThinking: true,
    contextWindow: 262144,
  },
  {
    id: 'zai',
    displayName: 'GLM(国际)',
    defaultModelId: 'glm-5.3',
    description: 'ZAI Coding Plan 国际区',
    // glm-5.3 reasoning=true, ctx=1000000
    supportsThinking: true,
    contextWindow: 1000000,
  },
  {
    id: 'zai-coding-cn',
    displayName: 'GLM(国内)',
    defaultModelId: 'glm-5.3',
    description: 'ZAI Coding Plan 国内区',
    supportsThinking: true,
    contextWindow: 1000000,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModelId: 'deepseek-v4-flash',
    description: 'DeepSeek 官方 API(flash 档)',
    // deepseek-v4-flash reasoning=true, ctx=1000000
    supportsThinking: true,
    contextWindow: 1000000,
  },
]

/** ZAI 默认模型(目录最新);live test 不可用时按 glm-5.2 → glm-4.7 回退。 */
export const ZAI_DEFAULT_MODEL = 'glm-5.3'

export function defaultModelFor(providerId: ProviderId): string {
  const entry = PROVIDER_CATALOG.find((p) => p.id === providerId)
  return entry?.defaultModelId ?? ''
}
