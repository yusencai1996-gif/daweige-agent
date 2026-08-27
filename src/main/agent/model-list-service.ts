import type { ModelOption } from '../../shared/ipc/contracts'
import type { ProviderId } from '../../shared/domain/provider'
import { PROVIDER_ENV_KEYS } from '../security/credential-store'
import type { CredentialStore } from '../security/credential-store'
import { PROVIDER_CATALOG, defaultModelFor, KNOWN_MODEL_WINDOWS } from '../agent/provider-catalog'

/**
 * 模型列表服务(A-10):填完 key 后在线拉取厂商可选模型,
 * 叠加本地规格表(models 接口普遍不返回上下文长度,规格离线配)。
 *
 * 端点(来源 pi 0.84.2 内置 provider 的 baseUrl,OpenAI 兼容 GET {base}/models):
 * - zai:           https://api.z.ai/api/coding/paas/v4/models
 * - zai-coding-cn: https://open.bigmodel.cn/api/coding/paas/v4/models
 * - deepseek:      https://api.deepseek.com/models
 * - kimi-coding:   coding plan 单模型(kimi-for-coding),不拉列表
 *
 * 安全:key 只在主进程内存使用(credentialStore.getByEnvKey),
 * 失败信息不携带 Authorization/key;在线失败回退本地默认并说明原因。
 */

const MODELS_URL: Partial<Record<ProviderId, string>> = {
  zai: 'https://api.z.ai/api/coding/paas/v4/models',
  'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4/models',
  deepseek: 'https://api.deepseek.com/models',
}

// 本地规格表已挪 provider-catalog(KNOWN_MODEL_WINDOWS),registry 兜底构造同源复用

const FETCH_TIMEOUT_MS = 10_000

export interface ModelListResult {
  readonly models: readonly ModelOption[]
  readonly notice?: string
}

export async function listProviderModels(
  providerId: ProviderId,
  credentialStore: CredentialStore,
): Promise<ModelListResult> {
  // Kimi coding plan:单模型,固定返回
  if (providerId === 'kimi-coding') {
    return {
      models: [
        { id: 'kimi-for-coding', contextWindow: 262_144, source: 'catalog' },
      ],
    }
  }

  const url = MODELS_URL[providerId]
  if (!url) {
    return { models: catalogFallback(providerId), notice: '这家暂不支持在线拉取,显示默认模型' }
  }

  const apiKey = credentialStore.getByEnvKey(PROVIDER_ENV_KEYS[providerId]!)
  if (!apiKey) {
    return { models: catalogFallback(providerId), notice: '还没填 Key:填好保存后就能拉取模型列表' }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      })
      if (!res.ok) {
        return { models: catalogFallback(providerId), notice: `在线拉取没成功(服务端返回 ${res.status}),先显示默认模型` }
      }
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
      // A-20:服务端可能返回重复条目(实测 GLM 列表 glm-5.3-flash 出现两次),拉取后去重
      const ids = [...new Set(
        (body.data ?? [])
          .map((m) => (typeof m.id === 'string' ? m.id : undefined))
          .filter((id): id is string => id !== undefined),
      )]
      if (ids.length === 0) {
        return { models: catalogFallback(providerId), notice: '在线列表是空的,先显示默认模型' }
      }
      const windows = KNOWN_MODEL_WINDOWS[providerId] ?? {}
      const online: ModelOption[] = ids.map((id) => ({
        id,
        ...(windows[id] !== undefined ? { contextWindow: windows[id] } : {}),
        source: 'online',
      }))
      // 本地默认若不在线列表里也带上(下拉至少有当前选中项)
      const fallback = defaultModelFor(providerId)
      if (fallback && !ids.includes(fallback)) {
        online.push({ id: fallback, ...(windows[fallback] !== undefined ? { contextWindow: windows[fallback] } : {}), source: 'catalog' })
      }
      return { models: online }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { models: catalogFallback(providerId), notice: '在线拉取失败(网络问题或 Key 无效),先显示默认模型' }
  }
}

function catalogFallback(providerId: ProviderId): ModelOption[] {
  const entry = PROVIDER_CATALOG.find((p) => p.id === providerId)
  const id = entry?.defaultModelId ?? ''
  if (!id) return []
  const windows = KNOWN_MODEL_WINDOWS[providerId] ?? {}
  return [{ id, ...(windows[id] !== undefined ? { contextWindow: windows[id] } : {}), source: 'catalog' }]
}
