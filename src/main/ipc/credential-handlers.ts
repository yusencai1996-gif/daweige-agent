import { PROVIDER_IDS } from '../../shared/domain/provider'
import type { CredentialStatus } from '../../shared/domain/provider'
import { registerHandler } from './handler'
import type { CredentialStore } from '../security/credential-store'
import type { ConnectivityService } from '../agent/connectivity-service'
import { listProviderModels } from '../agent/model-list-service'

/**
 * 凭据 IPC(M2-03 + M3-03)。
 * 铁律:任何响应都不包含完整 key,只有掩码状态。
 */

export function registerCredentialHandlers(
  store: CredentialStore,
  connectivity: ConnectivityService,
): void {
  registerHandler('credential:status', async (): Promise<CredentialStatus[]> =>
    PROVIDER_IDS.map((id) => store.status(id)),
  )

  registerHandler('credential:save', async ({ providerId, apiKey }) => {
    await store.saveProviderKey(providerId, apiKey)
    return store.status(providerId)
  })

  registerHandler('credential:delete', async ({ providerId }) => {
    await store.deleteProviderKey(providerId)
    return store.status(providerId)
  })

  registerHandler('credential:test', async ({ providerId }) => connectivity.test(providerId))

  // A-10:模型列表(在线拉+本地规格;失败回退默认,key 只在主进程内存使用)
  registerHandler('credential:listModels', async ({ providerId }) =>
    listProviderModels(providerId, store),
  )
}
