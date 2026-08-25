import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore as PiCredentialStore,
} from '@earendil-works/pi-ai'
import { PROVIDER_IDS, isProviderId } from '../../shared/domain/provider'
import type { CredentialStore } from '../security/credential-store'

/**
 * 我们的凭据仓库 → pi CredentialStore 适配(M3-02)。
 * pi 按 Provider.id 存取,且 providerId 是开放字符串;
 * 大微阁只支持四家,非四家的读写一律返回未配置。
 */

function toCredential(key: string | undefined): Credential | undefined {
  if (key === undefined) return undefined
  const cred: ApiKeyCredential = { type: 'api_key', key }
  return cred
}

export function createPiCredentialAdapter(store: CredentialStore): PiCredentialStore {
  return {
    read: async (providerId) =>
      isProviderId(providerId) ? toCredential(store.getProviderKey(providerId)) : undefined,

    list: async (): Promise<readonly CredentialInfo[]> =>
      PROVIDER_IDS.filter((id) => store.getProviderKey(id) !== undefined).map((id) => ({
        providerId: id,
        type: 'api_key' as const,
      })),

    modify: async (providerId, fn) => {
      if (!isProviderId(providerId)) return fn(undefined)
      const current = toCredential(store.getProviderKey(providerId))
      const next = await fn(current)
      if (next === undefined) {
        await store.deleteProviderKey(providerId)
        return undefined
      }
      if (next.type === 'api_key' && next.key !== undefined) {
        await store.saveProviderKey(providerId, next.key)
        return next
      }
      // OAuth 凭据第一版不支持,丢弃不落盘
      return undefined
    },

    delete: async (providerId) => {
      if (isProviderId(providerId)) {
        await store.deleteProviderKey(providerId)
      }
    },
  }
}
