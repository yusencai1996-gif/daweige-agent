import { describe, expect, it } from 'vitest'
import { ProviderRegistry, ProviderUnavailableError } from '../../../src/main/agent/provider-registry'
import { CredentialStore } from '../../../src/main/security/credential-store'
import type { SafeStorageAdapter } from '../../../src/main/security/safe-storage-adapter'
import { createPiCredentialAdapter } from '../../../src/main/agent/pi-credential-adapter'

function fakeSafeStorage(): SafeStorageAdapter {
  const guard = 'TEST:'
  return {
    isEncryptionAvailable: () => false, // 内存模式即可,不落盘
    encryptString: async (p) => Buffer.from(guard + p),
    decryptString: async () => ({ result: '', shouldReEncrypt: false }),
  }
}

function makeStore(): CredentialStore {
  return new CredentialStore({ safeStorage: fakeSafeStorage(), secretsDir: 'unused' })
}

describe('ProviderRegistry(M3-02)', () => {
  it('Kimi 静态目录:getModel 返回 kimi-for-coding', () => {
    const registry = new ProviderRegistry(makeStore())
    const model = registry.getModel('kimi-coding', 'kimi-for-coding')
    expect(model).toBeDefined()
    expect(model.api).toBe('anthropic-messages')
  })

  it('DeepSeek 静态目录:getModel 返回 deepseek-v4-flash', () => {
    const registry = new ProviderRegistry(makeStore())
    const model = registry.getModel('deepseek', 'deepseek-v4-flash')
    expect(model).toBeDefined()
    expect(model.api).toBe('openai-completions')
  })

  it('ZAI 两区 provider 已注册(目录动态,不依赖网络断言存在)', () => {
    const registry = new ProviderRegistry(makeStore())
    // provider 注册后 getModels 不抛;目录为空也返回数组
    expect(Array.isArray(registry.listKnownModels('zai'))).toBe(true)
    expect(Array.isArray(registry.listKnownModels('zai-coding-cn'))).toBe(true)
  })

  it('未知模型 ID 抛 ProviderUnavailableError(可理解错误)', () => {
    const registry = new ProviderRegistry(makeStore())
    expect(() => registry.getModel('kimi-coding', 'not-a-model')).toThrow(
      ProviderUnavailableError,
    )
  })

  it('未知 provider 的 getModel 抛错(不静默返回别的厂商)', () => {
    const registry = new ProviderRegistry(makeStore())
    expect(() => registry.getModel('deepseek', 'kimi-for-coding')).toThrow(
      ProviderUnavailableError,
    )
  })
})

describe('pi 凭据适配层', () => {
  it('read:配置过的厂商返回 api_key 凭据,未配置返回 undefined', async () => {
    const store = makeStore()
    await store.saveProviderKey('kimi-coding', 'sk-kimi-test-1234')
    const adapter = createPiCredentialAdapter(store)

    const kimi = await adapter.read('kimi-coding')
    expect(kimi).toEqual({ type: 'api_key', key: 'sk-kimi-test-1234' })

    expect(await adapter.read('zai')).toBeUndefined()
    // 非四家 provider(开放字符串)一律未配置
    expect(await adapter.read('anthropic')).toBeUndefined()
  })

  it('list:只列出已配置厂商,且不含 key 明文', async () => {
    const store = makeStore()
    await store.saveProviderKey('deepseek', 'sk-deep-test-1234')
    const list = await createPiCredentialAdapter(store).list()
    expect(list).toEqual([{ providerId: 'deepseek', type: 'api_key' }])
  })

  it('modify:写入与清空', async () => {
    const store = makeStore()
    const adapter = createPiCredentialAdapter(store)

    await adapter.modify('zai', async () => ({ type: 'api_key', key: 'sk-zai-test-1234' }))
    expect(store.getProviderKey('zai')).toBe('sk-zai-test-1234')

    await adapter.modify('zai', async () => undefined)
    expect(store.getProviderKey('zai')).toBeUndefined()
  })

  it('delete:只作用于四家之内', async () => {
    const store = makeStore()
    await store.saveProviderKey('kimi-coding', 'sk-kimi-test-1234')
    const adapter = createPiCredentialAdapter(store)
    await adapter.delete('kimi-coding')
    await adapter.delete('anthropic') // 不抛
    expect(store.getProviderKey('kimi-coding')).toBeUndefined()
  })
})
