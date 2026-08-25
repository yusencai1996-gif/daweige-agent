import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { DEFAULT_SETTINGS, SettingsStore } from '../../../src/main/storage/settings-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('无文件时返回默认设置', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'))
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
  })

  it('保存后重启恢复 Provider 选择(M2-04 验证标准)', async () => {
    const path = join(dir, 'settings.json')
    const first = new SettingsStore(path)
    await first.save({
      providerSelection: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      windowBounds: { width: 1400, height: 900, maximized: false },
      lastActiveSessionId: 'sess-1',
    })

    const second = new SettingsStore(path)
    const loaded = await second.load()
    expect(loaded.providerSelection.providerId).toBe('deepseek')
    expect(loaded.windowBounds?.width).toBe(1400)
    expect(loaded.lastActiveSessionId).toBe('sess-1')
  })

  it('文件损坏(JSON 断裂)回退默认', async () => {
    const path = join(dir, 'settings.json')
    await fs.writeFile(path, '{ not json !!!', 'utf-8')
    expect(await new SettingsStore(path).load()).toEqual(DEFAULT_SETTINGS)
  })

  it('内容非法(未知 providerId)回退默认', async () => {
    const path = join(dir, 'settings.json')
    await fs.writeFile(
      path,
      JSON.stringify({ providerSelection: { providerId: 'openai', modelId: 'x' } }),
      'utf-8',
    )
    expect(await new SettingsStore(path).load()).toEqual(DEFAULT_SETTINGS)
  })

  it('设置文件里不存在任何 key 形态字段(扫描验证)', async () => {
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path)
    await store.save({ providerSelection: { providerId: 'zai', modelId: 'glm-x' } })
    const raw = await readFile(path, 'utf-8')
    expect(raw).not.toMatch(/apikey|api_key|secret|token/i)
    expect(raw).not.toMatch(/sk-/)
  })
})
