import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { SettingsSchema } from '../../shared/ipc/schemas'
import type { Settings } from '../../shared/domain/settings'

/**
 * 非敏感设置持久化(M2-04)。
 * userData/settings.json;TypeBox 运行时校验;原子写(tmp+rename)。
 * 铁律:Settings 里没有任何 key 字段(类型层面已保证)。
 */

export const DEFAULT_SETTINGS: Settings = {
  providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
}

export class SettingsStore {
  private cached: Settings | undefined

  constructor(private readonly filePath: string) {}

  /** 最近一次 load/save 的内存快照(同步读;供请求路径取思考强度等即时值)。 */
  current(): Settings | undefined {
    return this.cached
  }

  /** 读取;文件缺失/损坏/校验失败一律回退默认值(设置非关键数据,可丢可重建)。 */
  async load(): Promise<Settings> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch {
      this.cached = DEFAULT_SETTINGS
      return DEFAULT_SETTINGS
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Value.Check(SettingsSchema, parsed)) {
        this.cached = DEFAULT_SETTINGS
        return DEFAULT_SETTINGS
      }
      this.cached = parsed as Settings
      return this.cached
    } catch {
      this.cached = DEFAULT_SETTINGS
      return DEFAULT_SETTINGS
    }
  }

  async save(settings: Settings): Promise<Settings> {
    if (!Value.Check(SettingsSchema, settings)) {
      throw new Error('设置数据不合法,拒绝保存')
    }
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    // 随机后缀防并发写撞同一 tmp(codex 复审建议)
    const tmp = `${this.filePath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
    this.cached = settings
    return settings
  }
}
