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

/**
 * 已知模型的上下文窗口(本地规格表;与 model-list-service 同源,厂商接口不返回此值)。
 * 数值来源(A-20 扩充,2026-08-27):
 * - GLM glm-4.7/5-turbo/5.2/5.2-highspeed/5.3 与 DeepSeek、Kimi 各型号:pi 0.84.2 静态模型表
 *   (node_modules/@earendil-works/pi-ai/dist/providers/data/*.json,与运行时 registry 兜底同源)
 * - glm-5.3-flash:官方文档 1M(docs.bigmodel.cn / docs.z.ai 的 GLM-5.3-Flash 页,pi 0.84.2 表外)
 */
export const KNOWN_MODEL_WINDOWS: Partial<Record<ProviderId, Record<string, number>>> = {
  'kimi-coding': {
    'kimi-for-coding': 262144,
    'kimi-for-coding-highspeed': 262144,
    'k3-256k': 262144,
    'k3': 1_048_576,
  },
  zai: {
    'glm-4.7': 204_800,
    'glm-5-turbo': 200_000,
    'glm-5.2': 1_000_000,
    'glm-5.2-highspeed': 1_000_000,
    'glm-5.3': 1_000_000,
    'glm-5.3-flash': 1_000_000,
  },
  'zai-coding-cn': {
    'glm-4.7': 204_800,
    'glm-5-turbo': 200_000,
    'glm-5.2': 1_000_000,
    'glm-5.2-highspeed': 1_000_000,
    'glm-5.3': 1_000_000,
    'glm-5.3-flash': 1_000_000,
  },
  deepseek: {
    'deepseek-v4-flash': 1_000_000,
    'deepseek-v4-pro': 1_000_000,
  },
}

/** 表外模型兜底的保守上下文窗口(宁可低估,不虚报预算)。 */
export const FALLBACK_CONTEXT_WINDOW = 131072
