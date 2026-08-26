import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../../../src/main/memory/memory-store'
import { ReminderService, type Clock } from '../../../src/main/memory/reminder-service'
import { createSaveMemoryTool, createSearchMemoriesTool } from '../../../src/main/agent/tools/memory-tools'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-mem-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('MemoryStore(M5-01)', () => {
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

  async function service(records: Awaited<ReturnType<MemoryStore['load']>>, clock: Clock) {
    return new ReminderService(async () => records, clock)
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
  it('save_memory 保存成功返回确认提示(不弹卡由 gate 保证)', async () => {
    const store = new MemoryStore(join(dir, 'm.json'))
    const tool = createSaveMemoryTool(store)
    const result = await tool.execute('tc1', {
      text: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
    })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((await store.load())).toHaveLength(1)
  })

  it('search_memories 找到记录', async () => {
    const store = new MemoryStore(join(dir, 'm.json'))
    await store.add({ text: '我妈生日是三月五号', title: '妈妈生日', category: '生日' })
    const tool = createSearchMemoriesTool(store)
    const result = await tool.execute('tc1', { query: '妈妈' })
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('妈妈生日')
  })

  it('remove 按 id 删除;id 不存在返回 false', async () => {
    const store = new MemoryStore(join(dir, 'm-remove.json'))
    const a = await store.add({ text: 'A', title: 'A', category: '事实' })
    const b = await store.add({ text: 'B', title: 'B', category: '事实' })
    expect(await store.remove(a.id)).toBe(true)
    const rest = await store.all()
    expect(rest).toHaveLength(1)
    expect(rest[0]?.id).toBe(b.id)
    expect(await store.remove('not-exist')).toBe(false)
  })
})
