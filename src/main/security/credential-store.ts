import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/domain/provider'
import type { CredentialStatus } from '../../shared/domain/provider'
import type { SafeStorageAdapter } from './safe-storage-adapter'
import { maskKey } from './redaction'

/**
 * 凭据仓库(M2-03)。
 * 形态:全部凭据序列化为一个 JSON,整体加密成单个密文文件
 * userData/secrets/credentials.bin(原子写:tmp + rename)。
 *
 * 降级策略(PLAN §2.7,红线:加密不可用时绝不明文落盘):
 * 1. init() 时探测 isEncryptionAvailable()
 * 2. 可用 → 密文文件;解密失败 → 保留原密文供诊断,内存降级,提示重输
 * 3. 不可用/加密失败 → 只存内存,UI 显示"仅本次运行有效"
 * 4. 渲染进程永远只拿 CredentialStatus(掩码)
 */

const CREDENTIALS_FILE = 'credentials.bin'

export const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  'kimi-coding': 'KIMI_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

/** 依赖注入便于单测(fake safeStorage + 临时目录)。 */
export interface CredentialStoreOptions {
  safeStorage: SafeStorageAdapter
  secretsDir: string
}

export class CredentialStore {
  private readonly safeStorage: SafeStorageAdapter
  private readonly secretsDir: string
  /** envVar → 明文 key;只在主进程内存。 */
  private readonly inMemory = new Map<string, string>()
  /** init 后确定:密文文件是否可用(否则内存降级)。 */
  private encryptedPersistence = false
  /** 解密失败的诊断标记(UI 提示重新输入)。 */
  private decryptFailed = false

  constructor(options: CredentialStoreOptions) {
    this.safeStorage = options.safeStorage
    this.secretsDir = options.secretsDir
  }

  get filePath(): string {
    return join(this.secretsDir, CREDENTIALS_FILE)
  }

  /** app.ready 之后调用一次。 */
  async init(): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.encryptedPersistence = false
      return
    }
    let encrypted: Buffer | undefined
    try {
      encrypted = await fs.readFile(this.filePath)
    } catch {
      encrypted = undefined // 首次使用,还没有密文文件
    }
    if (encrypted === undefined) {
      this.encryptedPersistence = true
      return
    }
    try {
      const { result: plain, shouldReEncrypt } = await this.safeStorage.decryptString(encrypted)
      const parsed: unknown = JSON.parse(plain)
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') this.inMemory.set(k, v)
        }
      }
      this.encryptedPersistence = true
      if (shouldReEncrypt) {
        // 系统加密密钥已轮换:立即用新密钥重新加密并原子替换密文文件
        await this.persist()
      }
    } catch {
      // 解密失败(如系统凭据变更):保留密文文件供诊断,降级内存模式,等用户重输
      this.encryptedPersistence = false
      this.decryptFailed = true
      this.inMemory.clear()
    }
  }

  isEncryptedPersistence(): boolean {
    return this.encryptedPersistence
  }

  /** 解密失败标记(true = UI 应提示"凭据读取失败,请重新填写")。 */
  isDecryptFailed(): boolean {
    return this.decryptFailed
  }

  isEphemeral(): boolean {
    return !this.encryptedPersistence
  }

  /** 应用层:保存某厂商 key。 */
  async saveProviderKey(providerId: ProviderId, apiKey: string): Promise<void> {
    this.inMemory.set(PROVIDER_ENV_KEYS[providerId]!, apiKey)
    this.decryptFailed = false
    await this.persist()
  }

  async deleteProviderKey(providerId: ProviderId): Promise<void> {
    this.inMemory.delete(PROVIDER_ENV_KEYS[providerId]!)
    await this.persist()
  }

  /** 应用层:取明文 key(仅主进程用,如 Provider 发请求)。 */
  getProviderKey(providerId: ProviderId): string | undefined {
    return this.inMemory.get(PROVIDER_ENV_KEYS[providerId]!)
  }

  /** 按 pi 的环境变量名取(供 M3 runtime credentials 桥)。 */
  getByEnvKey(envKey: string): string | undefined {
    return this.inMemory.get(envKey)
  }

  listEnvKeys(): string[] {
    return [...this.inMemory.keys()]
  }

  /** 渲染进程可见的唯一形态:掩码状态(含"仅本次运行有效"标记)。 */
  status(providerId: ProviderId): CredentialStatus {
    const key = this.getProviderKey(providerId)
    if (key === undefined) return { providerId, configured: false }
    return {
      providerId,
      configured: true,
      maskedKey: maskKey(key),
      // 加密不可用时只存内存,关闭即失效——UI 需如实提示
      ...(this.isEphemeral() ? { ephemeral: true } : {}),
    }
  }

  private async persist(): Promise<void> {
    if (!this.encryptedPersistence) {
      return // 内存降级:什么都不写,绝不落明文
    }
    await fs.mkdir(this.secretsDir, { recursive: true })
    const cipher = await this.safeStorage.encryptString(JSON.stringify(Object.fromEntries(this.inMemory)))
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, cipher)
    await fs.rename(tmp, this.filePath)
  }
}
