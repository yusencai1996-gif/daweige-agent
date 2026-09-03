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
import {
  FALLBACK_CONTEXT_WINDOW,
  KNOWN_MODEL_WINDOWS,
} from './provider-catalog'

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

  /**
   * 取模型;找不到(目录未加载/ID 拼错)抛 ProviderUnavailableError,由 IPC 层转中文提示。
   * pi 0.84.4 对 zai/kimi/deepseek 只有生成脚本写死的静态表,跟不上厂商上新
   * (如 glm-5.3-flash):设置页在线列表可选、运行时却认不出 →"模型还没准备好"
   * (用户 0827 真机实踩)。表外模型按同 provider 最接近的同家族模型动态构造
   * (继承 baseUrl/协议/兼容参数,上下文窗口用本地规格表或保守 128k)。
   */
  getModel(providerId: ProviderId, modelId: string): Model<Api> {
    const model = this.models.getModel(providerId, modelId)
    if (model) return model
    const constructed = this.constructFallbackModel(providerId, modelId)
    if (constructed) return constructed
    throw new ProviderUnavailableError(providerId, modelId)
  }

  /** 表外模型兜底:模板=同 provider 里与目标 id 公共前缀最长的已知模型;跨家族错配(前缀<3)不兜底。 */
  private constructFallbackModel(providerId: ProviderId, modelId: string): Model<Api> | undefined {
    const known = this.models.getModels(providerId)
    if (known.length === 0) return undefined
    const template = known.reduce((best, current) =>
      commonPrefixLength(current.id, modelId) > commonPrefixLength(best.id, modelId) ? current : best,
    )
    // 同家族才兜底(glm-5.3-flash↔glm-5.3);拿别家模型名来问(前缀 0)仍按未知拒绝,
    // 防跨 provider 错配构造出打错端点的模型
    if (commonPrefixLength(template.id, modelId) < 3) return undefined
    console.warn(
      `[models] ${modelId} 不在 pi 静态表,按同家族模型(${template.id})参数动态构造`,
    )
    return {
      ...template,
      id: modelId,
      name: modelId,
      contextWindow: KNOWN_MODEL_WINDOWS[providerId]?.[modelId] ?? FALLBACK_CONTEXT_WINDOW,
    }
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

/** 两个字符串的最长公共前缀长度(模板挑选用)。 */
function commonPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}
