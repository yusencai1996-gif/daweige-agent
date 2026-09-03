import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../../src/main/memory/memory-store'
import { GlobalMemoryStore } from '../../../src/main/memory/global-memory-store'
import type { MemoryEntry } from '../../../src/shared/domain/memory'
import { ReminderService, type Clock } from '../../../src/main/memory/reminder-service'
import { createAddMemoryNoteTool, createSaveMemoryTool, createSearchMemoriesTool } from '../../../src/main/agent/tools/memory-tools'
import { assertValidMemoryDate } from '../../../src/main/memory/memory-date'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-mem-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('MemoryStore(M5-01)', () => {
  it('E-3 fixed/recurring 日期做真实日历校验，2/29 合法而 2/30、4/31 和自动进位日期拒绝', async () => {
    expect(() => assertValidMemoryDate({ kind: 'fixed', iso: '2028-02-29' })).not.toThrow()
    expect(() => assertValidMemoryDate({ kind: 'recurring', month: 2, day: 29 })).not.toThrow()
    for (const date of [
      { kind: 'fixed', iso: '2026-02-31' }, { kind: 'fixed', iso: '2026-04-31' },
      { kind: 'recurring', month: 2, day: 30 }, { kind: 'recurring', month: 4, day: 31 },
    ]) expect(() => assertValidMemoryDate(date)).toThrow('日期')
    const store = new MemoryStore(join(dir, 'invalid-date.json'))
    await expect(store.add({ text: '坏日期', title: '坏', category: '事实', date: { kind: 'fixed', iso: '2026-02-31' } })).rejects.toThrow('日期')
  })
  it('保存 → 重启(新实例)→ 读回;不外发(本地文件)', async () => {
    const path = join(dir, 'data', 'memories.json')
    const first = new MemoryStore(path)
    await first.add({
      text: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
    })
    const second = new MemoryStore(path)
    const all = await second.load()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ title: '妈妈生日', date: { kind: 'recurring', month: 3, day: 5 } })
  })

  it('同文去重', async () => {
    const store = new MemoryStore(join(dir, 'm.json'))
    await store.add({ text: '喜欢喝绿茶', title: '饮茶偏好', category: '偏好' })
    await store.add({ text: '喜欢喝绿茶', title: '饮茶偏好', category: '偏好' })
    expect(await store.load()).toHaveLength(1)
  })

  it('文件损坏:坏文件挪走备份,从空开始不崩', async () => {
    const path = join(dir, 'm.json')
    await fs.writeFile(path, '{broken json!!', 'utf-8')
    const store = new MemoryStore(path)
    expect(await store.load()).toEqual([])
    // 诊断备份存在
    const files = await fs.readdir(dir)
    expect(files.some((f) => f.startsWith('m.json.corrupt-'))).toBe(true)
    // 之后还能正常写
    await store.add({ text: '新记录', title: '新', category: '事实' })
    expect((await new MemoryStore(path).load())).toHaveLength(1)
  })

  it('搜索:关键词命中标题/原文/类别', async () => {
    const store = new MemoryStore(join(dir, 'm.json'))
    await store.add({ text: '我妈生日是三月五号', title: '妈妈生日', category: '生日', date: { kind: 'recurring', month: 3, day: 5 } })
    await store.add({ text: '用户喜欢喝绿茶', title: '饮茶偏好', category: '偏好' })
    expect(await store.search('生日')).toHaveLength(1)
    expect(await store.search('绿茶')).toHaveLength(1)
    expect(await store.search('不存在的事')).toHaveLength(0)
  })
})

describe('ReminderService(M5-03,注入 Clock)', () => {
  function at(date: string): Clock {
    return { now: () => new Date(date) }
  }

  async function service(records: readonly MemoryEntry[], clock: Clock) {
    const store = new GlobalMemoryStore(join(dir, 'projected-memory'))
    await store.initialize()
    for (const [index, record] of records.entries()) {
      await store.addNote({
        filename: `2026-08-30T12-00-${String(index).padStart(2, '0')}-reminder-${index}.md`,
        note: record.text,
        metadata: { title: record.title, category: record.category, ...(record.date ? { date: record.date } : {}) },
      }, { kind: 'conversation', roleId: null, roleDisplayName: '测试' })
    }
    return new ReminderService(() => store.listReminderRecords(), clock)
  }

  it('今天(daysUntil=0)', async () => {
    const svc = await service(
      [{ id: '1', text: 'x', title: '妈妈生日', category: '生日', date: { kind: 'recurring', month: 8, day: 22 }, createdAt: 0 }],
      at('2026-08-22T10:00:00'),
    )
    const list = await svc.listUpcoming()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: '妈妈生日', daysUntil: 0, date: '2026-08-22' })
  })

  it('3 天后', async () => {
    const svc = await service(
      [{ id: '1', text: 'x', title: '交稿日', category: '纪念日', date: { kind: 'fixed', iso: '2026-08-25' }, createdAt: 0 }],
      at('2026-08-22T08:00:00'),
    )
    const list = await svc.listUpcoming()
    expect(list[0]).toMatchObject({ title: '交稿日', daysUntil: 3, date: '2026-08-25' })
  })

  it('7 天后(窗口内含)、8 天后(不提醒)', async () => {
    const records = [
      { id: '7', text: 'x', title: '七天事', category: '纪念日', date: { kind: 'fixed', iso: '2026-08-29' } as const, createdAt: 0 },
      { id: '8', text: 'x', title: '八天事', category: '纪念日', date: { kind: 'fixed', iso: '2026-08-30' } as const, createdAt: 0 },
    ]
    const svc = await service(records, at('2026-08-22T08:00:00'))
    const list = await svc.listUpcoming()
    expect(list.map((r) => r.title)).toEqual(['七天事'])
    expect(list[0]!.daysUntil).toBe(7)
  })

  it('跨年:12 月底看次年 1 月初的生日', async () => {
    const svc = await service(
      [{ id: '1', text: 'x', title: '爸爸生日', category: '生日', date: { kind: 'recurring', month: 1, day: 2 }, createdAt: 0 }],
      at('2026-12-28T09:00:00'),
    )
    const list = await svc.listUpcoming()
    expect(list[0]).toMatchObject({ title: '爸爸生日', date: '2027-01-02', daysUntil: 5 })
  })

  it('闰日生日在平年按 2/28 提示', async () => {
    const svc = await service(
      [{ id: '1', text: 'x', title: '小闰生日', category: '生日', date: { kind: 'recurring', month: 2, day: 29 }, createdAt: 0 }],
      at('2027-02-25T09:00:00'), // 2027 平年
    )
    const list = await svc.listUpcoming()
    expect(list[0]).toMatchObject({ date: '2027-02-28', daysUntil: 3 })
  })

  it('无日期记忆不产生提醒', async () => {
    const svc = await service(
      [{ id: '1', text: '喜欢喝绿茶', title: '饮茶偏好', category: '偏好', createdAt: 0 }],
      at('2026-08-22T09:00:00'),
    )
    expect(await svc.listUpcoming()).toEqual([])
  })
})

describe('记忆工具(M5-02)', () => {
  it('memory.add_note 使用语义 schema，主进程生成合法文件名、中文 slug 回退、撞名加序号并保存 date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T09:08:07'))
    try {
      const store = new GlobalMemoryStore(join(dir, 'memory'))
      await store.initialize()
      const tool = createAddMemoryNoteTool(store, { kind: 'conversation', roleId: null, roleDisplayName: '测试' })
      const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] }
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['category', 'date', 'text', 'title'])
      expect(schema.required).toEqual(['text'])

      await tool.execute('tc1', { text: '妈妈生日是三月五日', title: '妈妈生日', category: '生日', date: { kind: 'recurring', month: 3, day: 5 } })
      await tool.execute('tc2', { text: '妈妈生日的补充说明', title: '妈妈生日' })
      const entries = (await store.list()).entries
      expect(entries.map((entry) => entry.id)).toEqual([
        '2026-08-31T09-08-07-note.md',
        '2026-08-31T09-08-07-note-2.md',
      ])
      expect(entries[0]?.date).toEqual({ kind: 'recurring', month: 3, day: 5 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ENOENT 之外的 IO 错误上抛，不伪装成空库', async () => {
    const path = join(dir, 'memory-as-directory')
    await fs.mkdir(path)
    await expect(new MemoryStore(path).load()).rejects.toThrow()
  })

  it('save_memory 保存成功返回确认提示(不弹卡由 gate 保证)', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory'))
    await store.initialize()
    const tool = createSaveMemoryTool(store, { kind: 'conversation', roleId: null, roleDisplayName: '测试' })
    const result = await tool.execute('tc1', {
      text: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
    })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((await store.list()).entries).toHaveLength(1)
  })

  it('search_memories 找到记录', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory'))
    await store.initialize()
    await store.addNote({ filename: '2026-08-30T12-00-00-mama.md', note: '我妈生日是三月五号', metadata: { title: '妈妈生日', category: '生日' } }, { kind: 'conversation', roleId: null, roleDisplayName: '测试' })
    const tool = createSearchMemoriesTool(store)
    const result = await tool.execute('tc1', { query: '妈妈' })
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('妈妈生日')
  })

  it('remove 按 id 删除;id 不存在返回 false', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory'))
    await store.initialize()
    const source = { kind: 'conversation' as const, roleId: null, roleDisplayName: '测试' }
    const a = await store.addNote({ filename: '2026-08-30T12-00-00-a.md', note: 'A' }, source)
    const b = await store.addNote({ filename: '2026-08-30T12-00-01-b.md', note: 'B' }, source)
    expect((await store.delete(a.id)).deleted).toBe(true)
    const rest = (await store.list()).entries
    expect(rest).toHaveLength(1)
    expect(rest[0]?.id).toBe(b.id)
    expect((await store.delete('2026-08-30T12-00-02-not-exist.md')).deleted).toBe(false)
  })
})
