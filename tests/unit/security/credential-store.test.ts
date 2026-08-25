import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../../../src/main/security/credential-store'
import type { SafeStorageAdapter } from '../../../src/main/security/safe-storage-adapter'

/** 模拟 DPAPI:可配置"加密不可用/解密失败/密钥轮换(新旧密钥分体)"。 */
function createFakeSafeStorage(opts: {
  available?: boolean
  failDecrypt?: boolean
  shouldReEncrypt?: boolean
  /** 当前加密密钥版本(写密文用)。 */
  versionTag?: string
  /** 仍可解密的旧密钥版本(解密用),默认与 versionTag 相同。 */
  decryptVersionTag?: string
} = {}): SafeStorageAdapter {
  const encryptGuard = `FAKE-DPAPI(${opts.versionTag ?? 'v1'}):`
  const decryptGuard = `FAKE-DPAPI(${opts.decryptVersionTag ?? opts.versionTag ?? 'v1'}):`
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    encryptString: async (plain) =>
      Buffer.from(encryptGuard + Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
    decryptString: async (buf) => {
      if (opts.failDecrypt) throw new Error('解密失败(模拟系统凭据变更)')
      const s = buf.toString('utf8')
      if (!s.startsWith(decryptGuard)) throw new Error('密文损坏')
      return {
        result: Buffer.from(s.slice(decryptGuard.length), 'base64').toString('utf8'),
        shouldReEncrypt: opts.shouldReEncrypt ?? false,
      }
    },
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-secrets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const TEST_KEY = 'sk-test-1234567890abcdef'

describe('CredentialStore:加密可用', () => {
  it('保存后密文文件存在且不含明文 key 子串', async () => {
    const store = new CredentialStore({
      safeStorage: createFakeSafeStorage(),
      secretsDir: dir,
    })
    await store.init()
    await store.saveProviderKey('kimi-coding', TEST_KEY)

    const cipher = await fs.readFile(store.filePath)
    expect(cipher.length).toBeGreaterThan(0)
    expect(cipher.toString('utf8')).not.toContain(TEST_KEY)
  })

  it('重启(新实例)后 key 恢复', async () => {
    const first = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await first.init()
    await first.saveProviderKey('deepseek', TEST_KEY)

    const second = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await second.init()
    expect(second.getProviderKey('deepseek')).toBe(TEST_KEY)
    expect(second.isEphemeral()).toBe(false)
  })

  it('status 只返回掩码,不含完整 key', async () => {
    const store = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await store.init()
    await store.saveProviderKey('kimi-coding', TEST_KEY)

    const status = store.status('kimi-coding')
    expect(status).toEqual({
      providerId: 'kimi-coding',
      configured: true,
      maskedKey: 'sk-****cdef',
    })
    expect(JSON.stringify(status)).not.toContain(TEST_KEY)
  })

  it('删除后状态变为未配置', async () => {
    const store = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await store.init()
    await store.saveProviderKey('zai', TEST_KEY)
    await store.deleteProviderKey('zai')
    expect(store.status('zai')).toEqual({ providerId: 'zai', configured: false })
    expect(store.getProviderKey('zai')).toBeUndefined()
  })

  it('密钥轮换(shouldReEncrypt):立即用新密钥重写密文', async () => {
    // v1 密钥时代保存
    const first = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await first.init()
    await first.saveProviderKey('kimi-coding', TEST_KEY)

    // 系统密钥轮换到 v2,读旧密文时 Electron 提示 shouldReEncrypt
    const second = new CredentialStore({
      safeStorage: createFakeSafeStorage({
        versionTag: 'v2',
        decryptVersionTag: 'v1',
        shouldReEncrypt: true,
      }),
      secretsDir: dir,
    })
    await second.init()
    expect(second.getProviderKey('kimi-coding')).toBe(TEST_KEY)

    // 密文文件已用新密钥重写:纯 v2 环境能直接解开
    const third = new CredentialStore({
      safeStorage: createFakeSafeStorage({ versionTag: 'v2' }),
      secretsDir: dir,
    })
    await third.init()
    expect(third.getProviderKey('kimi-coding')).toBe(TEST_KEY)
    expect(third.isEphemeral()).toBe(false)
  })
})

describe('CredentialStore:内存降级', () => {
  it('加密不可用时:内存可用、绝不落盘', async () => {
    const store = new CredentialStore({
      safeStorage: createFakeSafeStorage({ available: false }),
      secretsDir: dir,
    })
    await store.init()
    await store.saveProviderKey('kimi-coding', TEST_KEY)

    expect(store.getProviderKey('kimi-coding')).toBe(TEST_KEY)
    expect(store.isEphemeral()).toBe(true)
    // 磁盘上不能出现任何凭据文件
    await expect(fs.readFile(store.filePath)).rejects.toThrow()
    const files = await fs.readdir(dir)
    expect(files).toEqual([])
  })

  it('解密失败时:保留原密文、内存清空、标记待重输', async () => {
    const first = new CredentialStore({ safeStorage: createFakeSafeStorage(), secretsDir: dir })
    await first.init()
    await first.saveProviderKey('kimi-coding', TEST_KEY)
    const cipherPath = first.filePath
    const before = await fs.readFile(cipherPath)

    const second = new CredentialStore({
      safeStorage: createFakeSafeStorage({ failDecrypt: true }),
      secretsDir: dir,
    })
    await second.init()

    expect(second.isDecryptFailed()).toBe(true)
    expect(second.getProviderKey('kimi-coding')).toBeUndefined()
    // 原密文文件保留供诊断,不被覆盖
    const after = await fs.readFile(cipherPath)
    expect(after.equals(before)).toBe(true)
  })
})
