import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * capability SID 存储(0.4.0 C3,PLAN §5.5-1)。
 * userData/sandbox/capabilities-v1.json:canonical writable root → 机器形态 SID(S-1-5-80-…)。
 * 语义:ACL 是锁(写根上的 allow-write ACE),token 只带对应钥匙;
 * 按 root 稳定复用(重启不换钥匙,幂等);损坏 fail-closed(丢弃重建,宁可重新授权)。
 */

interface CapStoreV1 {
  readonly schemaVersion: 1
  readonly entries: Record<string, string>
}

export class CapabilityStore {
  private cache: CapStoreV1 | undefined

  constructor(private readonly filePath: string) {}

  /** 取(或生成)该写根的 capability SID。 */
  async sidForRoot(canonicalRoot: string): Promise<string> {
    const store = await this.load()
    const existing = store.entries[canonicalRoot]
    if (existing?.startsWith('S-1-5-80-')) return existing
    const sid = generateCapabilitySid()
    const next: CapStoreV1 = {
      schemaVersion: 1,
      entries: { ...store.entries, [canonicalRoot]: sid },
    }
    await this.persist(next)
    this.cache = next
    return sid
  }

  private async load(): Promise<CapStoreV1> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf-8')) as CapStoreV1
      if (raw?.schemaVersion === 1 && raw.entries && typeof raw.entries === 'object') {
        this.cache = raw
        return raw
      }
      throw new Error('形态不合法')
    } catch {
      // 缺失/损坏:fail-closed 丢弃重建(旧钥匙作废,重新授权一次无害)
      const fresh: CapStoreV1 = { schemaVersion: 1, entries: {} }
      this.cache = fresh
      return fresh
    }
  }

  private async persist(store: CapStoreV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, this.filePath)
  }
}

/** 随机机器 SID:S-1-5-80-<5 个 32 位随机数>(与 Windows 服务 SID 同形态)。 */
export function generateCapabilitySid(): string {
  const parts = Array.from({ length: 5 }, () => randomBytes(4).readUInt32LE(0))
  return `S-1-5-80-${parts.join('-')}`
}
