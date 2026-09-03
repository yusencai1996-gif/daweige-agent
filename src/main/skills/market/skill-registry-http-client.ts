import { SkillRegistryError } from './registry'
import { MAX_REGISTRY_JSON_BYTES, MAX_SKILL_MARKDOWN_BYTES } from './skill-download-validator'

const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com'])

export interface SkillRegistryHttpClientOptions {
  readonly fetchImpl?: typeof fetch
}

export class SkillRegistryHttpClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: SkillRegistryHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async getJson<T>(url: URL, signal: AbortSignal, timeoutMs = 8_000): Promise<T> {
    const bytes = await this.get(url, signal, timeoutMs, MAX_REGISTRY_JSON_BYTES, 'application/json')
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T
    } catch {
      throw new SkillRegistryError('技能平台返回的数据格式不正确，请稍后再试。')
    }
  }

  async getMarkdown(url: URL, signal: AbortSignal, timeoutMs = 15_000): Promise<string> {
    const bytes = await this.get(url, signal, timeoutMs, MAX_SKILL_MARKDOWN_BYTES, 'text')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new SkillRegistryError('下载到的 SKILL.md 不是有效的 UTF-8 文本。')
    }
  }

  private async get(
    url: URL,
    callerSignal: AbortSignal,
    timeoutMs: number,
    maxBytes: number,
    responseKind: 'application/json' | 'text',
  ): Promise<Uint8Array> {
    assertAllowedUrl(url)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([callerSignal, timeout])
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          Accept: responseKind === 'application/json' ? 'application/vnd.github+json' : 'text/plain',
          'User-Agent': 'daweige-agent-skill-registry',
        },
        credentials: 'omit',
      })
    } catch (error) {
      if (callerSignal.aborted) throw new SkillRegistryError('技能搜索已停止，本次没有继续联网。')
      if (timeout.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new SkillRegistryError('连接技能平台超时，请检查网络后重试。')
      }
      throw new SkillRegistryError('暂时连不上技能平台，请检查网络后重试。')
    }
    if (response.status === 429 || response.status === 403) {
      throw new SkillRegistryError('GitHub 匿名搜索限速，稍后再试或从精选目录选择。')
    }
    if (response.status >= 500) {
      throw new SkillRegistryError('技能平台暂时不可用，请稍后再试。')
    }
    if (!response.ok) {
      throw new SkillRegistryError(response.status === 404
        ? '这个技能的 SKILL.md 没有找到。'
        : '技能平台拒绝了这次请求，请稍后再试。')
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(responseKind)
    if (!response.body) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        total += item.value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw tooLarge(responseKind)
        }
        chunks.push(item.value)
      }
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error
      if (callerSignal.aborted) throw new SkillRegistryError('技能搜索已停止，本次没有继续联网。')
      throw new SkillRegistryError('下载技能时网络中断了，请稍后重试。')
    }
    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return combined
  }
}

export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new SkillRegistryError('技能平台地址不在应用允许的安全范围内。')
  }
  if (url.username || url.password) throw new SkillRegistryError('技能平台地址不能包含认证信息。')
}

function tooLarge(kind: 'application/json' | 'text'): SkillRegistryError {
  return new SkillRegistryError(kind === 'text'
    ? '这个技能的 SKILL.md 超过 64 KiB，暂时不能安装。'
    : '技能平台返回的数据过大，本次已停止读取。')
}
