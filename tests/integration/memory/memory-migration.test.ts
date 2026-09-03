import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlobalMemoryStore } from '../../../src/main/memory/global-memory-store'
import { MemoryStore } from '../../../src/main/memory/memory-store'
import { ReminderService, type Clock } from '../../../src/main/memory/reminder-service'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'daweige-memory-migration-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) })

describe('生活记事迁移与提醒投影', () => {
  it('首次迁移保留旧 JSON、确定性文件名/元数据/打码，第二次启动不重复', async () => {
    const legacyPath = join(dir, 'data', 'memories.json'); const legacy = new MemoryStore(legacyPath)
    const old = await legacy.add({ text: '妈妈生日，api_key=abcdefghijklmnopqrs', title: '妈妈生日', category: '生日', date: { kind: 'recurring', month: 3, day: 5 } })
    const root = join(dir, 'daweige', 'memory'); const first = new GlobalMemoryStore(root); await first.initialize(legacy)
    const one = await first.list(); expect(one.entries).toHaveLength(1)
    expect(one.entries[0]).toMatchObject({ createdAt: old.createdAt, source: { kind: 'life-note-migration', legacyId: old.id }, title: '妈妈生日' })
    expect(one.entries[0]!.id).toMatch(/-life-note-[a-z0-9]+\.md$/)
    expect(one.entries[0]!.content).not.toContain('abcdefghijklmnopqrs')
    await expect(fs.stat(legacyPath)).resolves.toBeTruthy()
    const second = new GlobalMemoryStore(root); await second.initialize(new MemoryStore(legacyPath))
    expect((await second.list()).entries).toHaveLength(1)
  })

  it('迁移中断后按 legacyId 续跑，全部成功才 migrationVersion=1', async () => {
    const legacyPath = join(dir, 'data', 'memories.json'); await fs.mkdir(join(dir, 'data'), { recursive: true })
    const createdAt = new Date('2026-08-30T12:00:00').getTime()
    const root = join(dir, 'memory')
    // 先模拟上次仅完成第一条：第一次启动迁移 A，随后把 state 退回未完成并给旧库补上 B。
    await fs.writeFile(legacyPath, JSON.stringify([{ id: 'same-prefix-111', text: 'A', title: 'A', category: '事实', createdAt }]), 'utf8')
    const interrupted = new GlobalMemoryStore(root); await interrupted.initialize(new MemoryStore(legacyPath))
    const statePath = join(root, 'state.json'); const interruptedState = JSON.parse(await fs.readFile(statePath, 'utf8')) as { migrationVersion: number }
    interruptedState.migrationVersion = 0; await fs.writeFile(statePath, JSON.stringify(interruptedState), 'utf8')
    await fs.writeFile(legacyPath, JSON.stringify([
      { id: 'same-prefix-111', text: 'A', title: 'A', category: '事实', createdAt },
      { id: 'same-prefix-222', text: 'B', title: 'B', category: '事实', createdAt },
    ]), 'utf8')
    const resumed = new GlobalMemoryStore(root); await resumed.initialize(new MemoryStore(legacyPath))
    expect((await resumed.list()).entries).toHaveLength(2)
    expect(JSON.parse(await fs.readFile(join(root, 'state.json'), 'utf8')).migrationVersion).toBe(1)
  })

  it('legacy 标题先打码再生成文件名，IO 错误不推进 migrationVersion', async () => {
    const secret = 'sk-123456789012345678901234'
    const legacyPath = join(dir, 'legacy.json')
    await fs.writeFile(legacyPath, JSON.stringify([
      { id: 'legacy-secret', text: '正文', title: secret, category: '事实', createdAt: Date.now() },
    ]), 'utf8')
    const root = join(dir, 'memory')
    const migrated = new GlobalMemoryStore(root)
    await migrated.initialize(new MemoryStore(legacyPath))
    expect((await migrated.list()).entries[0]?.id).not.toContain(secret)
    expect(await fs.readFile(join(root, 'notes', 'index.json'), 'utf8')).not.toContain(secret)

    const brokenLegacyPath = join(dir, 'legacy-directory')
    await fs.mkdir(brokenLegacyPath)
    const failedRoot = join(dir, 'failed-memory')
    await expect(new GlobalMemoryStore(failedRoot).initialize(new MemoryStore(brokenLegacyPath))).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(join(failedRoot, 'state.json'), 'utf8')).migrationVersion).toBe(0)
  })

  it('ReminderService 算法不变，删除 note 后提醒同步消失', async () => {
    const root = join(dir, 'memory'); const store = new GlobalMemoryStore(root); await store.initialize()
    const note = await store.addNote({ filename: '2026-08-30T12-00-00-reminder.md', note: '交稿', metadata: { title: '交稿日', category: '安排', date: { kind: 'fixed', iso: '2026-09-02' } } }, { kind: 'conversation', roleId: null, roleDisplayName: '小柊' })
    const clock: Clock = { now: () => new Date('2026-08-30T09:00:00') }
    const reminders = new ReminderService(() => store.listReminderRecords(), clock)
    expect(await reminders.listUpcoming()).toEqual([{ memoryId: note.id, title: '交稿日', date: '2026-09-02', daysUntil: 3 }])
    await store.delete(note.id); expect(await reminders.listUpcoming()).toEqual([])
  })
})
