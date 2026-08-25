import {
  createModels,
  type Api,
  type Model,
  type MutableModels,
} from '@earendil-works/pi-ai'
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding'
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai'
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import type { ProviderId } from '../../shared/domain/provider'
import type { CredentialStore } from '../security/credential-store'
import { createPiCredentialAdapter } from './pi-credential-adapter'

/**
 * Provider Registry(M3-02)。
 * 只注册四家内置 provider(不引 providers/all,控制包体);
 * 凭据从应用仓库注入;ZAI 模型目录动态刷新(M3-01 live test 流程)。
 */

export class ProviderUnavailableError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelId: string,
  ) {
    super(`模型不可用:${providerId}/${modelId}`)
  }
}

export class ProviderRegistry {
  readonly models: MutableModels

  constructor(credentialStore: CredentialStore) {
    this.models = createModels({ credentials: createPiCredentialAdapter(credentialStore) })
    this.models.setProvider(kimiCodingProvider())
    this.models.setProvider(zaiProvider())
    this.models.setProvider(zaiCodingCnProvider())
    this.models.setProvider(deepseekProvider())
  }

  /** 取模型;找不到(目录未加载/ID 拼错)抛 ProviderUnavailableError,由 IPC 层转中文提示。 */
  getModel(providerId: ProviderId, modelId: string): Model<Api> {
    const model = this.models.getModel(providerId, modelId)
    if (!model) {
      throw new ProviderUnavailableError(providerId, modelId)
    }
    return model
  }

  /** 同步枚举当前已知模型(测试与 M3-01 枚举流程用)。 */
  listKnownModels(providerId: ProviderId): readonly Model<Api>[] {
    return this.models.getModels(providerId)
  }

  /**
   * M3-01:拉取动态模型目录(ZAI 两区)。需要该厂商已配置 key 且有网络。
   * 返回各 provider 的错误(不抛异常),供决策记录。
   */
  async refreshProviderCatalog(
    providerIds: readonly ProviderId[],
  ): Promise<ReadonlyMap<string, Error>> {
    const result = await this.models.refresh({ providers: [...providerIds] })
    return result.errors
  }
}
