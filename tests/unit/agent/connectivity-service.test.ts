import { describe, expect, it } from 'vitest'
import {
  ConnectivityService,
  TimeoutError,
  translateConnectivityError,
} from '../../../src/main/agent/connectivity-service'
import { ProviderRegistry } from '../../../src/main/agent/provider-registry'
import { CredentialStore } from '../../../src/main/security/credential-store'
import type { SafeStorageAdapter } from '../../../src/main/security/safe-storage-adapter'

function memoryStore(): CredentialStore {
  const adapter: SafeStorageAdapter = {
    isEncryptionAvailable: () => false,
    encryptString: async () => Buffer.alloc(0),
    decryptString: async () => ({ result: '', shouldReEncrypt: false }),
  }
  return new CredentialStore({ safeStorage: adapter, secretsDir: 'unused' })
}

describe('translateConnectivityError(M3-03 人话翻译)', () => {
  it.each([
    [new TimeoutError(20_000), '连接超时了,请检查网络后重试'],
    [new Error('Request timed out after 30s'), '连接超时了,请检查网络后重试'],
    [new Error('fetch failed'), '连不上服务器,请检查网络后重试'],
    [Object.assign(new Error('401 unauthorized'), { status: 401 }), 'Key 无效或没有权限,请检查后重新填写'],
    [Object.assign(new Error('403 forbidden'), { status: 403 }), 'Key 无效或没有权限,请检查后重新填写'],
    [Object.assign(new Error('429 too many requests'), { status: 429 }), '请求太频繁或套餐额度不足,请稍后再试'],
    [Object.assign(new Error('500 boom'), { status: 500 }), '服务商暂时出了点问题,请稍后再试'],
    [Object.assign(new Error('503 unavailable'), { status: 503 }), '服务商暂时出了点问题,请稍后再试'],
  ])('%s → %s', (err, expected) => {
    expect(translateConnectivityError(err, [])).toBe(expected)
  })

  it('错误信息里出现 key 明文时被脱敏', () => {
    const key = 'sk-leak-me-12345678'
    const out = translateConnectivityError(new Error(`boom at ${key}`), [key])
    expect(out).not.toContain(key)
    expect(out).toContain('***')
  })
})

describe('ConnectivityService(注入 probe)', () => {
  it('未配置 key:直接返回可读提示,不发请求', async () => {
    const store = memoryStore()
    let probeCalls = 0
    const service = new ConnectivityService(
      new ProviderRegistry(store),
      store,
      async () => {
        probeCalls++
      },
    )
    const result = await service.test('kimi-coding')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('填写')
    expect(probeCalls).toBe(0)
  })

  it('probe 成功:返回 ok 与模型名', async () => {
    const store = memoryStore()
    await store.saveProviderKey('kimi-coding', 'sk-kimi-test-1234')
    const service = new ConnectivityService(
      new ProviderRegistry(store),
      store,
      async () => {}, // 成功
    )
    const result = await service.test('kimi-coding')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('kimi-for-coding')
  })

  it('probe 抛 401:返回中文提示不抛异常(错误 key 不白屏)', async () => {
    const store = memoryStore()
    await store.saveProviderKey('kimi-coding', 'sk-wrong-key-1234')
    const service = new ConnectivityService(
      new ProviderRegistry(store),
      store,
      async () => {
        throw Object.assign(new Error('401'), { status: 401 })
      },
    )
    const result = await service.test('kimi-coding')
    expect(result).toEqual({ ok: false, message: 'Key 无效或没有权限,请检查后重新填写' })
  })

  it('probe 超时:返回超时提示', async () => {
    const store = memoryStore()
    await store.saveProviderKey('deepseek', 'sk-deep-test-1234')
    const service = new ConnectivityService(
      new ProviderRegistry(store),
      store,
      async () => {
        throw new TimeoutError(20_000)
      },
    )
    const result = await service.test('deepseek')
    expect(result).toEqual({ ok: false, message: '连接超时了,请检查网络后重试' })
  })
})
