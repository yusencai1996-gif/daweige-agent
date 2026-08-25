import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderId } from '../../shared/domain/provider'
import type { ConnectivityResult } from '../../shared/ipc/contracts'
import type { CredentialStore } from '../security/credential-store'
import { redactSecrets } from '../security/redaction'
import type { ProviderRegistry } from './provider-registry'
import { defaultModelFor } from './provider-catalog'

/**
 * 连通测试服务(M3-03)。
 * 对目标厂商发一个最小流式请求,收到首个文本增量即认为连通。
 * 错误统一翻译成人话;日志/错误信息一律脱敏,绝不出现 Authorization/key。
 */

/** 可注入的探测函数(默认实现走 models.streamSimple;测试注入各种失败形态)。 */
export type StreamProbe = (model: Model<Api>, timeoutMs: number) => Promise<void>

export const DEFAULT_PROBE_TIMEOUT_MS = 20_000

export class ConnectivityService {
  private readonly probe: StreamProbe

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly credentialStore: CredentialStore,
    probe?: StreamProbe,
  ) {
    this.probe = probe ?? defaultProbe(registry)
  }

  async test(providerId: ProviderId): Promise<ConnectivityResult> {
    if (this.credentialStore.getProviderKey(providerId) === undefined) {
      return { ok: false, message: '还没填写 Key,请先填写并保存' }
    }
    let model: Model<Api>
    try {
      model = this.registry.getModel(providerId, defaultModelFor(providerId))
    } catch {
      return { ok: false, message: '模型目录还没准备好,请稍后再试(需要联网拉取一次)' }
    }
    try {
      await this.probe(model, DEFAULT_PROBE_TIMEOUT_MS)
      return {
        ok: true,
        message: `连接正常,当前模型 ${model.id}`,
      }
    } catch (err) {
      const message = translateConnectivityError(err, [this.credentialStore.getProviderKey(providerId) ?? ''])
      return { ok: false, message }
    }
  }
}

/** 真实探测:发"你好",拿到第一个文本增量即成功断开。 */
function defaultProbe(registry: ProviderRegistry): StreamProbe {
  return (model, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        reject(new TimeoutError(timeoutMs))
      }, timeoutMs)
      try {
        const stream = registry.models.streamSimple(
          model,
          { messages: [{ role: 'user', content: '你好', timestamp: Date.now() }] },
          { signal: controller.signal },
        )
        void (async () => {
          try {
        for await (const event of stream) {
          if (event.type === 'text_delta') {
            clearTimeout(timer)
            controller.abort() // 收到首个增量即可判定连通,立刻断开省 token
            resolve()
            return
          }
          if (event.type === 'error') {
            clearTimeout(timer)
            reject(new StreamError(event.error.errorMessage))
            return
          }
        }
            clearTimeout(timer)
            resolve()
          } catch (err) {
            clearTimeout(timer)
            reject(err)
          }
        })()
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`)
  }
}

export class StreamError extends Error {
  constructor(message: string | undefined) {
    super(message ?? 'stream error')
  }
}

/** 错误翻译:任何形态 → 说人话的中文。纯函数,全量单测。 */
export function translateConnectivityError(err: unknown, secrets: string[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  const status = extractStatus(err) ?? extractStatusFromMessage(raw)
  if (err instanceof TimeoutError || /timeout|timed?\s?out|ETIMEDOUT/i.test(raw)) {
    return '连接超时了,请检查网络后重试'
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(raw)) {
    return '连不上服务器,请检查网络后重试'
  }
  if (status === 401 || status === 403) {
    return 'Key 无效或没有权限,请检查后重新填写'
  }
  if (status === 404) {
    return '找不到该模型,请稍后再试或换一个模型'
  }
  if (status === 429) {
    return '请求太频繁或套餐额度不足,请稍后再试'
  }
  if (status !== undefined && status >= 500) {
    return '服务商暂时出了点问题,请稍后再试'
  }
  const safe = redactSecrets(raw, secrets).slice(0, 120)
  return `连接失败:${safe}`
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

function extractStatusFromMessage(raw: string): number | undefined {
  const m = /(?:^|[(\s])(\d{3})[):]\s/.exec(raw)
  if (m && (m[1] === '401' || m[1] === '403' || m[1] === '404' || m[1] === '429' || Number(m[1]) >= 500)) {
    return Number(m[1])
  }
  return undefined
}
