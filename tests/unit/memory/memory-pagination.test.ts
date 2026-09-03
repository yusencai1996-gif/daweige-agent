import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlobalMemoryStore } from '../../../src/main/memory/global-memory-store'

let dir: string
const source = { kind: 'conversation' as const, roleId: null, roleDisplayName: '小柊' }
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'memory-page-e4-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('E-4 服务端记忆分页', () => {
  it('覆盖 0/1/50/51 条、稳定游标、revision reset，首屏不读取第 51 份正文', async () => {
    const root = join(dir, 'memory'); const diagnostics: string[] = []
    const store = new GlobalMemoryStore(root, undefined, (message) => diagnostics.push(message)); await store.initialize()
    expect(await store.listPage()).toMatchObject({ total: 0, entries: [], reset: false })
    for (let i = 0; i < 51; i += 1) {
      await store.addNote({ filename: `2026-09-03T16-05-${String(i).padStart(2, '0')}-page-${i}.md`, note: `正文-${i}` }, source)
    }
    const lastId = '2026-09-03T16-05-50-page-50.md'
    const outside = join(dir, 'outside.txt'); await fs.writeFile(outside, 'outside')
    await fs.unlink(join(root, 'notes', lastId))
    try { await fs.symlink(outside, join(root, 'notes', lastId), 'file') } catch { /* Windows 无权限时仍验证分页数量 */ }
    const first = await store.listPage({ limit: 50 })
    expect(first.entries).toHaveLength(50); expect(first.total).toBe(51); expect(first.nextCursor).toBeTruthy()
    expect(diagnostics).toEqual([])
    const second = await store.listPage({ cursor: first.nextCursor, limit: 50 })
    expect(second.nextCursor).toBeUndefined()
    for (let i = 51; i < 500; i += 1) {
      await store.addNote({ filename: `2026-09-03T17-${String(Math.floor(i / 100)).padStart(2, '0')}-${String(i % 100).padStart(2, '0')}-bulk-${i}.md`, note: `批量正文-${i}` }, source)
    }
    expect(await store.listPage({ limit: 100 })).toMatchObject({ total: 500, reset: false })
    await store.addNote({ filename: '2026-09-03T16-06-00-page-new.md', note: '新正文' }, source)
    const reset = await store.listPage({ cursor: first.nextCursor, limit: 1 })
    expect(reset).toMatchObject({ reset: true, total: 501 })
    expect(reset.entries[0]?.content).toBe('正文-0')
  })
})
