import { describe, expect, it, vi } from 'vitest'
import { listProviderModels } from '../../../src/main/agent/model-list-service'
import type { CredentialStore } from '../../../src/main/security/credential-store'

/**
 * A-10 模型列表服务:Kimi 固定单模型、无 key 回退、在线拉取解析+规格叠加、
 * 网络失败回退默认。fetch 全程 mock,不真出网。
 */

function storeWith(key: string | undefined): CredentialStore {
  return {
    getByEnvKey: (_envKey: string) => key,
  } as unknown as CredentialStore
}

describe('listProviderModels(A-10)', () => {
  it('Kimi coding plan:固定单模型,不在线拉', async () => {
    const result = await listProviderModels('kimi-coding', storeWith(undefined))
    expect(result.models).toEqual([{ id: 'kimi-for-coding', contextWindow: 262_144, source: 'catalog' }])
    expect(result.notice).toBeUndefined()
  })

  it('未填 key:回退默认模型并给出指引', async () => {
    const result = await listProviderModels('deepseek', storeWith(undefined))
    expect(result.models).toEqual([{ id: 'deepseek-v4-flash', contextWindow: 1_000_000, source: 'catalog' }])
    expect(result.notice).toContain('还没填 Key')
  })

  it('在线拉取:解析 data[].id,规格表内的带 contextWindow,表外的没有', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.4-air' }, { not_id: true }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await listProviderModels('zai', storeWith('sk-test'))
    expect(fetchMock).toHaveBeenCalledOnce()
    const auth = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers['Authorization']
    expect(auth).toBe('Bearer sk-test')
    expect(result.models).toHaveLength(2)
    expect(result.models[0]).toEqual({ id: 'glm-5.3', contextWindow: 1_000_000, source: 'online' })
    expect(result.models[1]).toEqual({ id: 'glm-5.4-air', source: 'online' }) // 规格未知不带 contextWindow
    expect(result.notice).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('服务端非 2xx:回退默认+中文说明(不透 key)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const result = await listProviderModels('deepseek', storeWith('sk-bad'))
    expect(result.models[0]!.id).toBe('deepseek-v4-flash')
    expect(result.notice).toContain('401')
    expect(result.notice).not.toContain('sk-bad')
    vi.unstubAllGlobals()
  })

  it('网络异常:回退默认+人话提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')))
    const result = await listProviderModels('zai-coding-cn', storeWith('sk-x'))
    expect(result.models[0]).toEqual({ id: 'glm-5.3', contextWindow: 1_000_000, source: 'catalog' })
    expect(result.notice).toContain('在线拉取失败')
    vi.unstubAllGlobals()
  })

  it('在线列表为空:回退默认', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))
    const result = await listProviderModels('zai', storeWith('sk-x'))
    expect(result.models[0]!.id).toBe('glm-5.3')
    expect(result.notice).toContain('空的')
    vi.unstubAllGlobals()
  })

  it('A-20 服务端重复条目去重:glm-5.3-flash 出现两次只显示一次,且规格表内有 contextWindow', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.3-flash' }, { id: 'glm-5.3-flash' }, { id: 'glm-5.3' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await listProviderModels('zai', storeWith('sk-test'))
    const flashCount = result.models.filter((m) => m.id === 'glm-5.3-flash').length
    expect(flashCount).toBe(1)
    expect(result.models).toHaveLength(2)
    expect(result.models.find((m) => m.id === 'glm-5.3-flash')).toEqual({ id: 'glm-5.3-flash', contextWindow: 1_000_000, source: 'online' })
    vi.unstubAllGlobals()
  })

  it('A-20 规格表扩充:pi 静态表模型在线拉取时都带 contextWindow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.2' }, { id: 'glm-5-turbo' }, { id: 'glm-4.7' }] }),
    }))
    const result = await listProviderModels('zai-coding-cn', storeWith('sk-test'))
    expect(result.models.find((m) => m.id === 'glm-5.2')?.contextWindow).toBe(1_000_000)
    expect(result.models.find((m) => m.id === 'glm-5-turbo')?.contextWindow).toBe(200_000)
    expect(result.models.find((m) => m.id === 'glm-4.7')?.contextWindow).toBe(204_800)
    vi.unstubAllGlobals()
  })
})
