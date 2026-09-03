import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryEntry } from '../../shared/domain/memory'
import { assertValidMemoryDate, isValidMemoryDate } from './memory-date'

/**
 * 生活记事存储(M5-01)。
 * userData/data/memories.json;数据只在本机,不外发(除正常对话上下文)。
 * 原子写(tmp+rename);损坏时把坏文件挪去 .corrupt 备查并从空开始,不崩应用。
 */

export class MemoryStore {
  private cache: MemoryEntry[] | undefined
  /** 写操作串行队列(codex 复审阻断项:并发 add/remove 共用固定 .tmp 会互相覆盖/丢数据)。 */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  /** 所有写操作排队执行,天然互斥。 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op)
    this.writeChain = next.catch(() => {})
    return next
  }

  async load(): Promise<MemoryEntry[]> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = []
      return this.cache
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not array')
      const records = parsed.filter(isValidMemory)
      this.cache = records
      return records
    } catch {
      // 损坏:保留现场供诊断,从空开始
      await fs
        .rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        .catch(() => {})
      this.cache = []
      return this.cache
    }
  }

  async add(input: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryEntry> {
    return this.enqueue(async () => {
      if (input.date !== undefined) assertValidMemoryDate(input.date)
      const records = await this.load()
      const entry: MemoryEntry = {
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
      }
      // 同文去重:完全相同的记忆不重复存
      if (records.some((r) => r.text === entry.text && r.title === entry.title)) {
        return entry
      }
      records.push(entry)
      await this.persist(records)
      return entry
    })
  }

  /** 简单包含匹配(标题+原文+类别),大小写不敏感。 */
  async search(query: string): Promise<MemoryEntry[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const records = await this.load()
    return records.filter((r) =>
      `${r.title}\n${r.text}\n${r.category}`.toLowerCase().includes(q),
    )
  }

  async all(): Promise<MemoryEntry[]> {
    return this.load()
  }

  /** 记忆管理(验收新增):按 id 删除一条;返回是否真的删到。 */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const records = await this.load()
      const next = records.filter((r) => r.id !== id)
      if (next.length === records.length) return false
      await this.persist(next)
      return true
    })
  }

  private async persist(records: readonly MemoryEntry[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    // 随机后缀:即使未来出现绕过队列的写入也不会撞同一个 tmp 文件
    const tmp = `${this.filePath}.${randomUUID().slice(0, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(records, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
    this.cache = [...records]
  }
}

function isValidMemory(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v['id'] !== 'string') return false
  if (typeof v['text'] !== 'string' || typeof v['title'] !== 'string') return false
  if (typeof v['category'] !== 'string') return false
  if (typeof v['createdAt'] !== 'number') return false
  if (v['date'] !== undefined && !isValidMemoryDate(v['date'])) return false
  return true
}
