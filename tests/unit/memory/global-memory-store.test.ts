import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlobalMemoryStore, isValidMemoryNoteId } from '../../../src/main/memory/global-memory-store'

let dir: string
const source = { kind: 'conversation' as const, roleId: 'agent-123456789abc', roleDisplayName: '账房' }
const id = (suffix: string, second = '00') => `2026-08-30T12-00-${second}-${suffix}.md`

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'daweige-global-memory-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) })

describe('GlobalMemoryStore layout / state / safety', () => {
  it('创建三层布局，主文件不由 store 创建，初始快照 clean', async () => {
    const root = join(dir, 'memory'); const store = new GlobalMemoryStore(root)
    await store.initialize()
    expect(await fs.readdir(root)).toEqual(expect.arrayContaining(['notes', 'state.json']))
    expect(await fs.readdir(join(root, 'notes'))).toContain('index.json')
    await expect(fs.stat(join(root, 'MEMORY.md'))).rejects.toThrow()
    expect(await store.list()).toEqual({ revision: 0, mergeState: 'clean', entries: [] })
  })

  it('filename 正反例、wx 撞名、正文空值与 20KiB 边界', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    expect(isValidMemoryNoteId(id('valid'))).toBe(true)
    for (const bad of ['../x.md', 'MEMORY.md', '2026-08-30T12-00-00-X.md', '2026-08-30T12-00-00-a/b.md']) expect(isValidMemoryNoteId(bad)).toBe(false)
    await expect(store.addNote({ filename: '../x.md', note: 'x' }, source)).rejects.toThrow('格式')
    await expect(store.addNote({ filename: id('empty'), note: '  ' }, source)).rejects.toThrow('20 KiB')
    await store.addNote({ filename: id('limit'), note: 'x'.repeat(20 * 1024) }, source)
    await expect(store.addNote({ filename: id('large'), note: 'x'.repeat(20 * 1024 + 1) }, source)).rejects.toThrow('20 KiB')
    await expect(store.addNote({ filename: id('limit'), note: 'again' }, source)).rejects.toThrow('已存在')
  })

  it('add 入库前打码且 source 只取主进程注入值', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    await store.addNote({ filename: id('secret'), note: 'api_key=abcdefghijklmnopqrs sk-12345678901234567890' }, source)
    const entry = (await store.list()).entries[0]!
    expect(entry.content).not.toContain('abcdefghijklmnopqrs')
    expect(entry.content).not.toContain('12345678901234567890')
    expect(entry.source).toEqual(source)
  })

  it('生成文件名、index 标题与 roleDisplayName 均先打码', async () => {
    const root = join(dir, 'memory'); const store = new GlobalMemoryStore(root); await store.initialize()
    const secret = 'sk-123456789012345678901234'
    const entry = await store.addGeneratedNote(
      { text: '正文', title: secret },
      { kind: 'conversation', roleId: null, roleDisplayName: secret },
    )
    const indexText = await fs.readFile(join(root, 'notes', 'index.json'), 'utf8')
    expect(entry.id).not.toContain(secret)
    expect(indexText).not.toContain(secret)
    expect(JSON.stringify(await store.list())).not.toContain(secret)
  })

  it('并发 add/delete/clear 共享串行队列，revision 单调且索引不丢', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    const [a, b, c] = await Promise.all([
      store.addNote({ filename: id('a', '01'), note: 'A' }, source),
      store.addNote({ filename: id('b', '02'), note: 'B' }, source),
      store.addNote({ filename: id('c', '03'), note: 'C' }, source),
    ])
    expect((await store.list()).revision).toBe(3)
    await Promise.all([store.delete(a.id), store.delete(b.id)])
    expect((await store.list()).entries.map((x) => x.id)).toEqual([c.id])
    const cleared = await store.clear()
    expect(cleared).toMatchObject({ deletedCount: 1, revision: 6 })
    expect((await store.list()).entries).toEqual([])
  })

  it('根 symlink 关闭记忆；note symlink 被忽略并产生诊断', async () => {
    const target = join(dir, 'target'); await fs.mkdir(target)
    const link = join(dir, 'linked-memory')
    try { await fs.symlink(target, link, 'junction') } catch { return }
    await expect(new GlobalMemoryStore(link).initialize()).rejects.toThrow('符号链接')

    const diagnostics: string[] = []; const root = join(dir, 'memory'); const store = new GlobalMemoryStore(root, undefined, (m) => diagnostics.push(m)); await store.initialize()
    const note = await store.addNote({ filename: id('symlink'), note: 'real' }, source)
    await fs.unlink(join(root, 'notes', note.id)); await fs.symlink(join(dir, 'outside.txt'), join(root, 'notes', note.id), 'file')
    expect((await store.list()).entries).toEqual([])
    expect(diagnostics.join('\n')).toContain('符号链接')
  })

  it('legacy 同名不同内容只跳过冲突条目并给出 memories.json 自愈指引', async () => {
    const legacyPath = join(dir, 'memories.json')
    const createdAt = new Date('2026-08-30T12:00:00').getTime()
    await fs.writeFile(legacyPath, JSON.stringify([
      { id: 'abcdefghijkl-1', text: '第一条', title: '相同标题', category: '事实', createdAt },
      { id: 'abcdefghijkl-2', text: '不同内容', title: '相同标题', category: '事实', createdAt },
    ]), 'utf8')
    const diagnostics: string[] = []
    const store = new GlobalMemoryStore(join(dir, 'memory'), undefined, (message) => diagnostics.push(message))
    const { MemoryStore } = await import('../../../src/main/memory/memory-store')
    await store.initialize(new MemoryStore(legacyPath))
    expect((await store.list()).entries).toHaveLength(1)
    expect(diagnostics.join('\n')).toContain('memories.json 存在重复条目')
    expect(JSON.parse(await fs.readFile(join(dir, 'memory', 'state.json'), 'utf8')).migrationVersion).toBe(0)
    const restarted = new GlobalMemoryStore(join(dir, 'memory'), undefined, (message) => diagnostics.push(message))
    await restarted.initialize(new MemoryStore(legacyPath))
    expect(diagnostics.filter((message) => message.includes('memories.json 存在重复条目'))).toHaveLength(2)
    expect(JSON.parse(await fs.readFile(join(dir, 'memory', 'state.json'), 'utf8')).migrationVersion).toBe(0)
  })

  it('启动自愈 index 空但磁盘残留 note 的分裂目录，清空语义不复活', async () => {
    const root = join(dir, 'memory'); const first = new GlobalMemoryStore(root); await first.initialize()
    const note = await first.addNote({ filename: id('orphan'), note: '不应复活' }, source)
    await fs.writeFile(join(root, 'notes', 'index.json'), JSON.stringify({ schemaVersion: 1, entries: [] }), 'utf8')
    const diagnostics: string[] = []
    const restarted = new GlobalMemoryStore(root, undefined, (message) => diagnostics.push(message))
    await restarted.initialize()
    expect((await restarted.list()).entries).toEqual([])
    await expect(fs.stat(join(root, 'notes', note.id))).rejects.toThrow()
    expect((await restarted.clear()).deletedCount).toBe(0)
    expect(diagnostics.join('\n')).toContain('已自愈 note/index 分裂')
  })
})

describe('memory.search / memory.read', () => {
  it('多关键词、中文标点、窗口合并、稳定排序、结果 cap', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    await store.addNote({ filename: id('dense', '01'), note: '前二\n前一\n妈妈生日就在三月五号\n后一\n后二\n妈妈的生日请记牢' }, source)
    await store.addNote({ filename: id('sparse', '02'), note: '妈妈\n空\n空\n生日' }, source)
    const hits = await store.search('妈妈，生日', 1)
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ path: `notes/${id('dense', '01')}`, lineStart: 1, lineEnd: 6 })
    expect(Buffer.byteLength(hits[0]!.excerpt, 'utf8')).toBeLessThanOrEqual(20 * 1024)
  })

  it('dirty 时不搜索旧 MEMORY.md；clean 时可搜索', async () => {
    const root = join(dir, 'memory'); const store = new GlobalMemoryStore(root); await store.initialize()
    await fs.writeFile(join(root, 'MEMORY.md'), '旧摘要独有词', 'utf8')
    expect(await store.search('旧摘要独有词')).toHaveLength(1)
    await store.addNote({ filename: id('dirty'), note: '当前 note' }, source)
    expect(await store.search('旧摘要独有词')).toEqual([])
  })

  it('read 限逻辑路径、按 1-based 行号、200 行与 20KiB 截断、返回前打码', async () => {
    const store = new GlobalMemoryStore(join(dir, 'memory')); await store.initialize()
    const note = await store.addNote({ filename: id('read'), note: Array.from({ length: 250 }, (_, i) => i === 2 ? 'token=abcdefghijklmnopqrs' : `line-${i + 1}`).join('\n') }, source)
    const result = await store.read(`notes/${note.id}`, 2, 240)
    expect(result).toMatchObject({ lineStart: 2, lineEnd: 201, truncated: true })
    expect(result.content).not.toContain('abcdefghijklmnopqrs')
    expect((await store.read(`notes/${note.id}`, 245, 999))).toMatchObject({ lineEnd: 250, truncated: false })
    await expect(store.read('../state.json')).rejects.toThrow('只允许')
    await expect(store.read('notes/2026-08-30T12-00-00-missing.md')).rejects.toThrow('不存在')
  })
})
