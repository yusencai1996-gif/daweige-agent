import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  MemoryDate,
  MemoryEntry,
  MemoryListPage,
  MemoryListPageRequest,
  MemoryListSnapshot,
  MemoryMergeState,
  MemoryNoteSummary,
  MemorySource,
} from '../../shared/domain/memory'
import type { AgentPushEvent } from '../../shared/ipc/events'
import { redactCommonSecrets } from '../security/redaction'
import type { MemoryStore } from './memory-store'
import { assertValidMemoryDate } from './memory-date'

const NOTE_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$/
const MAX_NOTE_BYTES = 20 * 1024
const MAX_SEARCH_BYTES = 20 * 1024
const CONSOLIDATION_RETRY_COOLDOWN_MS = 5 * 60_000

interface MemoryState {
  schemaVersion: 1
  revision: number
  mergedRevision: number
  migrationVersion: number
  lastMergeErrorAt?: number
  lastMergeErrorRevision?: number
}

interface NoteIndexEntry {
  id: string
  createdAt: number
  source: MemorySource
  legacyId?: string
  title?: string
  category?: string
  date?: MemoryDate
}

interface NoteIndex { schemaVersion: 1; entries: NoteIndexEntry[] }

export interface MemoryPromptNote {
  readonly id: string
  readonly createdAt: number
  readonly content: string
  readonly title?: string
  readonly category?: string
}

export interface MemoryPromptSnapshot {
  readonly revision: number
  readonly mergedRevision: number
  readonly mergeState: 'clean' | 'pending' | 'running' | 'failed'
  readonly summary?: string
  readonly notes: readonly MemoryPromptNote[]
}

export interface MemoryConsolidationSnapshot extends MemoryPromptSnapshot {
  readonly existingMemoryManual: string
  readonly existingSummary: string
}

export interface AddMemoryNoteInput {
  filename: string
  note: string
  metadata?: { title?: string; category?: string; date?: MemoryDate }
}

export interface AddGeneratedMemoryNoteInput {
  text: string
  title?: string
  category?: string
  date?: MemoryDate
}

export interface MemorySearchHit {
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly excerpt: string
}

export interface MemoryReadResult {
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly content: string
  readonly truncated: boolean
}

export class MemoryUnavailableError extends Error {
  constructor(message = '记忆目录当前不可用；请检查目录是否为符号链接，修复后重启应用。') {
    super(message)
    this.name = 'MemoryUnavailableError'
  }
}

export class GlobalMemoryStore {
  private readonly notesRoot: string
  private readonly statePath: string
  private readonly indexPath: string
  private writeChain: Promise<unknown> = Promise.resolve()
  private ready: Promise<void> | undefined
  private runningRevision: number | undefined

  constructor(
    private readonly root: string,
    private readonly emitEvent?: (event: AgentPushEvent) => void,
    private readonly diagnostic: (message: string) => void = (message) => console.warn(message),
  ) {
    this.notesRoot = join(root, 'notes')
    this.statePath = join(root, 'state.json')
    this.indexPath = join(this.notesRoot, 'index.json')
  }

  initialize(legacy?: MemoryStore): Promise<void> {
    this.ready ??= this.initializeOnce(legacy)
    return this.ready
  }

  async addNote(input: AddMemoryNoteInput, source: MemorySource): Promise<MemoryNoteSummary> {
    await this.ensureReady()
    return this.enqueue(() => this.addNoteLocked(input, source, true))
  }

  /** Agent 工具只提交语义字段；文件名在主进程串行生成并处理同秒撞名。 */
  async addGeneratedNote(input: AddGeneratedMemoryNoteInput, source: MemorySource): Promise<MemoryNoteSummary> {
    await this.ensureReady()
    return this.enqueue(async () => {
      const index = await this.readIndex()
      const occupied = new Set(index.entries.map((entry) => entry.id))
      const now = Date.now()
      let filename = generatedFilename(redactCommonSecrets(input.title ?? input.text), occupied, now)
      while (await pathExists(this.notePath(filename))) {
        occupied.add(filename)
        filename = generatedFilename(redactCommonSecrets(input.title ?? input.text), occupied, now)
      }
      return this.addNoteLocked({
        filename,
        note: input.text,
        metadata: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
        },
      }, source, true)
    })
  }

  async list(): Promise<MemoryListSnapshot> {
    await this.ensureReady()
    const [state, index] = await Promise.all([this.readState(), this.readIndex()])
    const entries: MemoryNoteSummary[] = []
    for (const item of index.entries) {
      const content = await this.readIndexedNote(item.id)
      if (content === undefined) continue
      entries.push({
        id: item.id,
        content: redactCommonSecrets(content),
        createdAt: item.createdAt,
        source: redactMemorySource(item.source),
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.category !== undefined ? { category: item.category } : {}),
        ...(item.date !== undefined ? { date: item.date } : {}),
      })
    }
    return { revision: state.revision, mergeState: this.mergeState(state), entries }
  }

  /** index-first 分页：只读取本页正文；游标绑定 revision 与末项位置。 */
  async listPage(request: MemoryListPageRequest = {}): Promise<MemoryListPage> {
    await this.ensureReady()
    const [state, index] = await Promise.all([this.readState(), this.readIndex()])
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('记忆分页数量必须为 1～100')
    let start = 0
    let reset = false
    if (request.cursor !== undefined) {
      const cursor = decodeMemoryCursor(request.cursor)
      if (!cursor || cursor.revision !== state.revision) reset = true
      else {
        const position = index.entries.findIndex((entry) => entry.id === cursor.id && entry.createdAt === cursor.createdAt)
        if (position < 0) reset = true
        else start = position + 1
      }
    }
    const pageIndex = index.entries.slice(start, start + limit)
    const entries: MemoryNoteSummary[] = []
    for (const item of pageIndex) {
      const content = await this.readIndexedNote(item.id)
      if (content === undefined) continue
      entries.push(toMemoryNoteSummary(item, content))
    }
    const last = pageIndex.at(-1)
    const hasMore = start + pageIndex.length < index.entries.length
    return {
      revision: state.revision,
      mergeState: this.mergeState(state),
      entries,
      ...(hasMore && last ? { nextCursor: encodeMemoryCursor(state.revision, last) } : {}),
      total: index.entries.length,
      reset,
    }
  }

  /** 供 prompt 构造读取的一致快照；dirty/failed 时绝不返回旧摘要。 */
  async promptSnapshot(): Promise<MemoryPromptSnapshot> {
    await this.ensureReady()
    return this.enqueue(async () => {
      const [state, index] = await Promise.all([this.readState(), this.readIndex()])
      const notes = await this.readPromptNotes(index)
      const stateForPrompt = this.mergeState(state)
      const summary = stateForPrompt === 'clean'
        ? await this.safeReadSearchFile(join(this.root, 'memory_summary.md'))
        : undefined
      return {
        revision: state.revision,
        mergedRevision: state.mergedRevision,
        mergeState: stateForPrompt,
        ...(summary !== undefined ? { summary: redactCommonSecrets(summary) } : {}),
        notes,
      }
    })
  }

  /** 单飞服务取得 revision+全部 notes 快照，并把 UI 状态切到 running。 */
  async beginConsolidation(): Promise<MemoryConsolidationSnapshot | undefined> {
    await this.ensureReady()
    return this.enqueue(async () => {
      const [state, index] = await Promise.all([this.readState(), this.readIndex()])
      if (!isMemoryDirty(state.revision, state.mergedRevision)) return undefined
      if (
        state.lastMergeErrorRevision === state.revision
        && state.lastMergeErrorAt !== undefined
        && Date.now() - state.lastMergeErrorAt < CONSOLIDATION_RETRY_COOLDOWN_MS
      ) return undefined
      this.runningRevision = state.revision
      delete state.lastMergeErrorAt
      delete state.lastMergeErrorRevision
      await this.writeJsonAtomic(this.statePath, state)
      const [notes, existingMemoryManual, existingSummary] = await Promise.all([
        this.readPromptNotes(index),
        this.safeReadSearchFile(join(this.root, 'MEMORY.md')).then((value) => value ?? ''),
        this.safeReadSearchFile(join(this.root, 'memory_summary.md')).then((value) => value ?? ''),
      ])
      return {
        revision: state.revision,
        mergedRevision: state.mergedRevision,
        mergeState: 'running',
        notes,
        existingMemoryManual: redactCommonSecrets(existingMemoryManual),
        existingSummary: redactCommonSecrets(existingSummary),
      }
    })
  }

  /** 两主文件仅由 consolidation 经此入口提交；summary rename 是最后提交点。 */
  async commitConsolidation(
    snapshotRevision: number,
    output: { summaryBody: string; memoryManual: string },
  ): Promise<void> {
    await this.ensureReady()
    await this.enqueue(async () => {
      const summaryBody = redactCommonSecrets(output.summaryBody.trim())
      const memoryManual = redactCommonSecrets(output.memoryManual)
      if (Buffer.byteLength(memoryManual, 'utf8') > 256 * 1024) {
        throw new Error('MEMORY.md 超过 256 KiB 上限')
      }
      const memoryPath = join(this.root, 'MEMORY.md')
      const summaryPath = join(this.root, 'memory_summary.md')
      const suffix = randomUUID().slice(0, 12)
      const memoryTemp = `${memoryPath}.${suffix}.tmp`
      const summaryTemp = `${summaryPath}.${suffix}.tmp`
      try {
        await fs.writeFile(memoryTemp, memoryManual, { encoding: 'utf8', flag: 'wx' })
        await fs.writeFile(summaryTemp, `v1\n${summaryBody}`, { encoding: 'utf8', flag: 'wx' })
        await fs.rename(memoryTemp, memoryPath)
        await fs.rename(summaryTemp, summaryPath)
      } finally {
        await Promise.all([
          fs.unlink(memoryTemp).catch(() => {}),
          fs.unlink(summaryTemp).catch(() => {}),
        ])
      }
      const state = await this.readState()
      if (state.revision === snapshotRevision) state.mergedRevision = snapshotRevision
      delete state.lastMergeErrorAt
      delete state.lastMergeErrorRevision
      await this.writeJsonAtomic(this.statePath, state)
      this.runningRevision = undefined
      this.changed(state, 'consolidated')
    })
  }

  async failConsolidation(snapshotRevision: number): Promise<void> {
    await this.ensureReady()
    await this.enqueue(async () => {
      const state = await this.readState()
      this.runningRevision = undefined
      if (state.revision === snapshotRevision) {
        state.lastMergeErrorAt = Date.now()
        state.lastMergeErrorRevision = snapshotRevision
        await this.writeJsonAtomic(this.statePath, state)
      }
      this.changed(state, 'consolidation-failed')
    })
  }

  async delete(id: string): Promise<{ deleted: boolean; revision: number; mergeState: MemoryMergeState }> {
    await this.ensureReady()
    return this.enqueue(async () => {
      assertNoteId(id)
      const index = await this.readIndex()
      const position = index.entries.findIndex((entry) => entry.id === id)
      if (position < 0) {
        const state = await this.readState()
        return { deleted: false, revision: state.revision, mergeState: this.mergeState(state) }
      }
      await fs.unlink(this.notePath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      index.entries.splice(position, 1)
      const state = await this.readState()
      state.revision += 1
      clearMergeFailure(state)
      await this.persistIndexAndState(index, state)
      this.changed(state, 'note-deleted')
      return { deleted: true, revision: state.revision, mergeState: this.mergeState(state) }
    })
  }

  async clear(): Promise<{ deletedCount: number; revision: number; mergeState: MemoryMergeState }> {
    await this.ensureReady()
    return this.enqueue(async () => {
      const index = await this.readIndex()
      let deletedCount = 0
      for (const entry of index.entries) {
        if (!isNoteId(entry.id)) continue
        try {
          await fs.unlink(this.notePath(entry.id))
          deletedCount += 1
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (index.entries.length === 0) {
        const state = await this.readState()
        return { deletedCount: 0, revision: state.revision, mergeState: this.mergeState(state) }
      }
      const state = await this.readState()
      state.revision += 1
      clearMergeFailure(state)
      await this.persistIndexAndState({ schemaVersion: 1, entries: [] }, state)
      this.changed(state, 'cleared')
      return { deletedCount, revision: state.revision, mergeState: this.mergeState(state) }
    })
  }

  async listReminderRecords(): Promise<MemoryEntry[]> {
    await this.ensureReady()
    const index = await this.readIndex()
    return index.entries.map((entry) => ({
      id: entry.id,
      text: '',
      title: entry.title ?? '生活记事',
      category: entry.category ?? '事实',
      ...(entry.date ? { date: entry.date } : {}),
      createdAt: entry.createdAt,
    }))
  }

  async search(query: string, maxResults = 8): Promise<MemorySearchHit[]> {
    await this.ensureReady()
    const terms = splitQuery(query)
    if (terms.length === 0) return []
    const state = await this.readState()
    const index = await this.readIndex()
    const files: Array<{ path: string; diskPath: string; order: number }> = []
    if (state.revision === state.mergedRevision) {
      files.push({ path: 'MEMORY.md', diskPath: join(this.root, 'MEMORY.md'), order: 0 })
    }
    index.entries.forEach((entry, i) => {
      files.push({ path: `notes/${entry.id}`, diskPath: this.notePath(entry.id), order: i + 1 })
    })
    const candidates: Array<MemorySearchHit & { score: number; order: number }> = []
    // 标题/类别只存在 index 元数据里,不进 note 正文;但它们是重要搜索线索——
    // 命中时生成指向正文头部的虚拟窗口(excerpt=标题+正文头三行)。
    for (let e = 0; e < index.entries.length; e += 1) {
      const entry = index.entries[e]!
      const metaLine = `${entry.title ?? ''} ${entry.category ?? ''}`.trim()
      if (!metaLine) continue
      const metaMatch = matchQuery(metaLine, terms)
      if (!metaMatch.accepted) continue
      const body = await this.safeReadSearchFile(this.notePath(entry.id))
      const head = body === undefined ? '' : body.split(/\r?\n/).slice(0, 3).join('\n')
      candidates.push({
        path: `notes/${entry.id}`,
        lineStart: 1,
        lineEnd: 3,
        excerpt: redactCommonSecrets(`${metaLine}\n${head}`),
        score: metaMatch.score,
        order: e + 1,
      })
    }
    for (const file of files) {
      const content = await this.safeReadSearchFile(file.diskPath)
      if (content === undefined) continue
      const lines = content.split(/\r?\n/)
      const windows: Array<{ start: number; end: number; score: number }> = []
      for (let i = 0; i < lines.length; i += 1) {
        const lower = lines[i]!.normalize('NFKC').toLocaleLowerCase()
        const matched = matchQuery(lower, terms)
        if (!matched.accepted) continue
        const positions = matched.positions
        const spread = positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : lower.length
        windows.push({ start: Math.max(0, i - 2), end: Math.min(lines.length - 1, i + 2), score: matched.score - spread })
      }
      for (const window of mergeWindows(windows)) {
        candidates.push({
          path: file.path,
          lineStart: window.start + 1,
          lineEnd: window.end + 1,
          excerpt: redactCommonSecrets(lines.slice(window.start, window.end + 1).join('\n')),
          score: window.score,
          order: file.order,
        })
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.order - b.order || a.lineStart - b.lineStart)
    const output: MemorySearchHit[] = []
    let bytes = 0
    for (const hit of candidates.slice(0, Math.min(8, Math.max(1, maxResults)))) {
      const overhead = Buffer.byteLength(`${output.length > 0 ? '\n\n' : ''}${hit.path}:${hit.lineStart}-${hit.lineEnd}\n`, 'utf8')
      const remaining = MAX_SEARCH_BYTES - bytes - overhead
      const excerpt = truncateUtf8(hit.excerpt, remaining)
      const size = Buffer.byteLength(excerpt, 'utf8')
      if (size === 0) break
      bytes += overhead + size
      output.push({ path: hit.path, lineStart: hit.lineStart, lineEnd: hit.lineEnd, excerpt })
      if (excerpt !== hit.excerpt) break
    }
    return output
  }

  async read(path: string, lineStart = 1, lineEnd?: number): Promise<MemoryReadResult> {
    await this.ensureReady()
    if (!Number.isInteger(lineStart) || lineStart < 1 || (lineEnd !== undefined && (!Number.isInteger(lineEnd) || lineEnd < lineStart))) {
      throw new Error('行号必须是从 1 开始的有效范围')
    }
    let diskPath: string
    if (path === 'MEMORY.md') {
      diskPath = join(this.root, 'MEMORY.md')
    } else if (path.startsWith('notes/')) {
      const id = path.slice('notes/'.length)
      assertNoteId(id)
      const index = await this.readIndex()
      if (!index.entries.some((entry) => entry.id === id)) throw new Error('记忆条目不存在')
      diskPath = this.notePath(id)
    } else {
      throw new Error('只允许读取 MEMORY.md 或已登记的 notes/<id>')
    }
    const raw = await this.safeReadSearchFile(diskPath)
    if (raw === undefined) throw new Error('记忆文件不存在或不可读取')
    const lines = raw.split(/\r?\n/)
    const requestedEnd = lineEnd ?? lineStart + 199
    const cappedEnd = Math.min(requestedEnd, lineStart + 199, lines.length)
    const selected: string[] = []
    let bytes = 0
    // 请求越过 EOF 只是自然读完；只有 200 行/20KiB 限额使请求范围内仍有内容未返回才算截断。
    let truncated = cappedEnd < Math.min(requestedEnd, lines.length)
    for (let i = lineStart - 1; i < cappedEnd; i += 1) {
      const line = lines[i] ?? ''
      const size = Buffer.byteLength(`${line}${selected.length ? '\n' : ''}`, 'utf8')
      if (bytes + size > MAX_SEARCH_BYTES) { truncated = true; break }
      selected.push(line)
      bytes += size
    }
    const actualEnd = lineStart + Math.max(0, selected.length - 1)
    if (actualEnd < Math.min(requestedEnd, lines.length)) truncated = true
    return { path, lineStart, lineEnd: actualEnd, content: redactCommonSecrets(selected.join('\n')), truncated }
  }

  private async initializeOnce(legacy?: MemoryStore): Promise<void> {
    await this.ensureSafeLayout()
    await this.ensureJsonFiles()
    await this.reconcileIndexWithDisk()
    if (legacy) await this.migrateLegacy(legacy)
  }

  private async migrateLegacy(legacy: MemoryStore): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readState()
      if (state.migrationVersion >= 1) return
      const records = await legacy.load()
      let index = await this.readIndex()
      let skippedConflict = false
      for (const record of records) {
        if (index.entries.some((entry) => entry.legacyId === record.id)) continue
        const filename = legacyFilename(record)
        try {
          await this.addNoteLocked({
            filename,
            note: record.text,
            metadata: { title: record.title, category: record.category, ...(record.date ? { date: record.date } : {}) },
          }, { kind: 'life-note-migration', legacyId: record.id }, false, record.createdAt, true)
        } catch (error) {
          if (!(error instanceof MemoryNoteConflictError)) throw error
          skippedConflict = true
          this.diagnostic(`[memory] 已跳过迁移撞名条目:${filename}；memories.json 存在重复条目，请检查同一时间和标题下的不同内容。`)
        }
        index = await this.readIndex()
      }
      const finalState = await this.readState()
      if (skippedConflict) return
      finalState.migrationVersion = 1
      await this.writeJsonAtomic(this.statePath, finalState)
      this.changed(finalState, 'migrated')
    })
  }

  private async addNoteLocked(
    input: AddMemoryNoteInput,
    source: MemorySource,
    notify: boolean,
    createdAtOverride?: number,
    adoptMatchingOrphan = false,
  ): Promise<MemoryNoteSummary> {
    assertNoteId(input.filename)
    if (input.metadata?.date !== undefined) assertValidMemoryDate(input.metadata.date)
    const note = redactCommonSecrets(input.note.trim())
    const noteBytes = Buffer.byteLength(note, 'utf8')
    if (noteBytes < 1 || noteBytes > MAX_NOTE_BYTES) throw new Error('记忆正文必须为 1～20 KiB')
    const index = await this.readIndex()
    if (index.entries.some((entry) => entry.id === input.filename)) {
      throw new MemoryNoteConflictError(input.filename)
    }
    const state = await this.readState()
    const createdAt = createdAtOverride ?? Date.now()
    const item: NoteIndexEntry = {
      id: input.filename,
      createdAt,
      source: redactMemorySource(source),
      ...(source.kind === 'life-note-migration' ? { legacyId: source.legacyId } : {}),
      ...(input.metadata?.title !== undefined ? { title: redactCommonSecrets(input.metadata.title) } : {}),
      ...(input.metadata?.category !== undefined ? { category: redactCommonSecrets(input.metadata.category) } : {}),
      ...(input.metadata?.date !== undefined ? { date: input.metadata.date } : {}),
    }
    const path = this.notePath(input.filename)
    let createdFile = false
    try {
      await fs.writeFile(path, note, { encoding: 'utf8', flag: 'wx' })
      createdFile = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (!adoptMatchingOrphan || await this.readIndexedNote(input.filename) !== note) {
          throw new MemoryNoteConflictError(input.filename)
        }
        this.diagnostic(`[memory] 迁移续跑接管未登记的确定性 note:${input.filename}`)
      } else {
        throw error
      }
    }
    index.entries.push(item)
    state.revision += 1
    clearMergeFailure(state)
    try {
      await this.persistIndexAndState(index, state)
    } catch (error) {
      if (createdFile) await fs.unlink(path).catch(() => {})
      throw error
    }
    if (notify) this.changed(state, 'note-added')
    return { id: item.id, content: note, createdAt, source: item.source, ...(item.title ? { title: item.title } : {}), ...(item.category ? { category: item.category } : {}), ...(item.date ? { date: item.date } : {}) }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation)
    this.writeChain = next.catch(() => {})
    return next
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.initialize()
    else await this.ready
  }

  private async ensureSafeLayout(): Promise<void> {
    await assertNotSymlink(this.root)
    await fs.mkdir(this.root, { recursive: true })
    await assertNotSymlink(this.root)
    await assertNotSymlink(this.notesRoot)
    await fs.mkdir(this.notesRoot, { recursive: true })
    await assertNotSymlink(this.notesRoot)
    const rootReal = await fs.realpath(this.root)
    const notesReal = await fs.realpath(this.notesRoot)
    if (!isWithin(rootReal, notesReal)) throw new MemoryUnavailableError()
  }

  private async ensureJsonFiles(): Promise<void> {
    await createJsonIfMissing(this.statePath, defaultState())
    await createJsonIfMissing(this.indexPath, { schemaVersion: 1, entries: [] } satisfies NoteIndex)
  }

  /** 启动时收口上次崩溃造成的 note/index 分裂；不猜测丢失元数据，孤儿文件直接清理。 */
  private async reconcileIndexWithDisk(): Promise<void> {
    const [state, index, dirents] = await Promise.all([
      this.readState(),
      this.readIndex(),
      fs.readdir(this.notesRoot, { withFileTypes: true }),
    ])
    const diskNoteIds = new Set(
      dirents.filter((entry) => entry.isFile() && isNoteId(entry.name)).map((entry) => entry.name),
    )
    const registered = new Set(index.entries.map((entry) => entry.id))
    const missing = index.entries.filter((entry) => !diskNoteIds.has(entry.id))
    const orphans = [...diskNoteIds].filter((id) => !registered.has(id))
    if (missing.length === 0 && orphans.length === 0) return

    for (const id of orphans) await fs.unlink(this.notePath(id))
    const repaired: NoteIndex = {
      schemaVersion: 1,
      entries: index.entries.filter((entry) => diskNoteIds.has(entry.id)),
    }
    state.revision += 1
    clearMergeFailure(state)
    await this.persistIndexAndState(repaired, state)
    this.diagnostic(`[memory] 已自愈 note/index 分裂：清理孤儿 ${orphans.length} 条，剔除悬空索引 ${missing.length} 条。`)
  }

  private async readState(): Promise<MemoryState> {
    const value = JSON.parse(await this.readProtectedFile(this.statePath)) as Partial<MemoryState>
    if (value.schemaVersion !== 1 || !Number.isInteger(value.revision) || !Number.isInteger(value.mergedRevision) || !Number.isInteger(value.migrationVersion)) throw new Error('记忆 state.json 已损坏')
    return value as MemoryState
  }

  private async readIndex(): Promise<NoteIndex> {
    const value = JSON.parse(await this.readProtectedFile(this.indexPath)) as Partial<NoteIndex>
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('记忆 index.json 已损坏')
    const entries = value.entries.filter((entry): entry is NoteIndexEntry => typeof entry === 'object' && entry !== null && isNoteId((entry as NoteIndexEntry).id))
    return { schemaVersion: 1, entries }
  }

  private async persistIndexAndState(index: NoteIndex, state: MemoryState): Promise<void> {
    await this.writeJsonAtomic(this.statePath, state)
    await this.writeJsonAtomic(this.indexPath, index)
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temp, path)
  }

  private notePath(id: string): string {
    assertNoteId(id)
    const path = resolve(this.notesRoot, id)
    if (basename(path) !== id || !isWithin(this.notesRoot, path)) throw new Error('非法记忆路径')
    return path
  }

  private async readIndexedNote(id: string): Promise<string | undefined> {
    return this.safeReadSearchFile(this.notePath(id))
  }

  private async readPromptNotes(index: NoteIndex): Promise<MemoryPromptNote[]> {
    const notes: MemoryPromptNote[] = []
    for (const entry of index.entries) {
      const content = await this.readIndexedNote(entry.id)
      if (content === undefined) continue
      notes.push({
        id: entry.id,
        createdAt: entry.createdAt,
        content: redactCommonSecrets(content),
        ...(entry.title !== undefined ? { title: redactCommonSecrets(entry.title) } : {}),
        ...(entry.category !== undefined ? { category: redactCommonSecrets(entry.category) } : {}),
      })
    }
    return notes
  }

  private async safeReadSearchFile(path: string): Promise<string | undefined> {
    try {
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink()) {
        this.diagnostic(`[memory] 忽略符号链接文件:${basename(path)}`)
        return undefined
      }
      if (!stat.isFile()) return undefined
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readProtectedFile(path: string): Promise<string> {
    const stat = await fs.lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new MemoryUnavailableError('记忆元数据文件不安全，已关闭记忆功能；修复后请重启应用。')
    return fs.readFile(path, 'utf8')
  }

  private changed(state: MemoryState, reason: Extract<AgentPushEvent, { type: 'memory_changed' }>['reason']): void {
    this.emitEvent?.({ type: 'memory_changed', revision: state.revision, reason, mergeState: this.mergeState(state) })
  }

  private mergeState(state: MemoryState): 'clean' | 'pending' | 'running' | 'failed' {
    if (!isMemoryDirty(state.revision, state.mergedRevision)) return 'clean'
    if (this.runningRevision === state.revision) return 'running'
    if (state.lastMergeErrorRevision === state.revision) return 'failed'
    return 'pending'
  }
}

export function isValidMemoryNoteId(id: string): boolean { return isNoteId(id) }
export function isMemoryDirty(revision: number, mergedRevision: number): boolean {
  return revision > mergedRevision
}

function isNoteId(id: unknown): id is string {
  return typeof id === 'string' && NOTE_ID.test(id) && Buffer.byteLength(id, 'utf8') >= 24 && Buffer.byteLength(id, 'utf8') <= 128
}

function assertNoteId(id: string): void {
  if (!isNoteId(id)) throw new Error('记忆文件名格式不合法')
}

class MemoryNoteConflictError extends Error {
  constructor(filename: string) {
    super(`记忆文件已存在:${filename}`)
    this.name = 'MemoryNoteConflictError'
  }
}

function defaultState(): MemoryState { return { schemaVersion: 1, revision: 0, mergedRevision: 0, migrationVersion: 0 } }
function clearMergeFailure(state: MemoryState): void {
  delete state.lastMergeErrorAt
  delete state.lastMergeErrorRevision
}

async function createJsonIfMissing(path: string, value: unknown): Promise<void> {
  try { await fs.writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
}

async function assertNotSymlink(path: string): Promise<void> {
  try { if ((await fs.lstat(path)).isSymbolicLink()) throw new MemoryUnavailableError() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

type QueryTerm = { readonly value: string; readonly kind: 'phrase' | 'ngram' | 'word' }

const QUESTION_STOP_WORDS = ['请问', '麻烦', '帮我', '告诉我', '我想知道', '想知道', '是什么', '怎么样', '有没有', '关于']

function splitQuery(query: string): QueryTerm[] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase()
  const terms: QueryTerm[] = []
  const seen = new Set<string>()
  const push = (value: string, kind: QueryTerm['kind']) => {
    if (!value || seen.has(`${kind}:${value}`) || terms.length >= 32) return
    seen.add(`${kind}:${value}`)
    terms.push({ value, kind })
  }
  for (const word of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (!/^[\p{Script=Han}]+$/u.test(word)) push(word, 'word')
  }
  for (const rawRun of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    let run = rawRun
    for (const stop of QUESTION_STOP_WORDS) run = run.replaceAll(stop, '')
    run = run.replace(/^[我的你他她它们这那]+|[的吗呢啊吧呀了]$/gu, '')
    if (!run) continue
    push(run, 'phrase')
    const chars = [...run]
    for (const size of [3, 2]) {
      for (let i = 0; i <= chars.length - size; i += 1) push(chars.slice(i, i + size).join(''), 'ngram')
    }
  }
  return terms
}

function matchQuery(text: string, terms: readonly QueryTerm[]): { score: number; positions: number[]; accepted: boolean } {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const hits = terms.filter((term) => normalized.includes(term.value))
  const phraseHit = hits.some((term) => term.kind === 'phrase')
  const ngramHits = new Set(hits.filter((term) => term.kind === 'ngram').map((term) => term.value)).size
  const queryHasManyNgrams = new Set(terms.filter((term) => term.kind === 'ngram').map((term) => term.value)).size >= 4
  const accepted = hits.length > 0 && (!queryHasManyNgrams || phraseHit || ngramHits >= 2)
  const score = hits.reduce((sum, term) => sum + (term.kind === 'phrase' ? 5000 : term.kind === 'ngram' ? 1000 : 1500), 0)
  return { score, positions: hits.map((term) => normalized.indexOf(term.value)), accepted }
}

function toMemoryNoteSummary(item: NoteIndexEntry, content: string): MemoryNoteSummary {
  return {
    id: item.id, content: redactCommonSecrets(content), createdAt: item.createdAt,
    source: redactMemorySource(item.source),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}),
    ...(item.date !== undefined ? { date: item.date } : {}),
  }
}

function encodeMemoryCursor(revision: number, item: NoteIndexEntry): string {
  return Buffer.from(JSON.stringify({ r: revision, c: item.createdAt, i: item.id }), 'utf8').toString('base64url')
}

function decodeMemoryCursor(value: string): { revision: number; createdAt: number; id: string } | undefined {
  if (!value || value.length > 256) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!Number.isInteger(parsed['r']) || !Number.isFinite(parsed['c']) || !isNoteId(parsed['i'])) return undefined
    return { revision: parsed['r'] as number, createdAt: parsed['c'] as number, id: parsed['i'] as string }
  } catch { return undefined }
}

function mergeWindows(windows: Array<{ start: number; end: number; score: number }>): Array<{ start: number; end: number; score: number }> {
  const output: Array<{ start: number; end: number; score: number }> = []
  for (const current of windows) {
    const previous = output.at(-1)
    if (previous && current.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, current.end)
      previous.score = Math.max(previous.score, current.score)
    } else output.push({ ...current })
  }
  return output
}

function legacyFilename(entry: MemoryEntry): string {
  const date = new Date(entry.createdAt)
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const slug = redactCommonSecrets(entry.title).toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'note'
  const legacy = entry.id.toLocaleLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'legacy'
  return `${stamp}-life-${slug}-${legacy}.md`
}

function redactMemorySource(source: MemorySource): MemorySource {
  return source.kind === 'conversation'
    ? { ...source, roleDisplayName: redactCommonSecrets(source.roleDisplayName) }
    : source
}

function generatedFilename(seed: string, occupied: ReadonlySet<string>, now: number): string {
  const date = new Date(now)
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const slug = seed.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'note'
  let sequence = 1
  while (true) {
    const suffix = sequence === 1 ? '' : `-${sequence}`
    const candidate = `${stamp}-${slug}${suffix}.md`
    if (!occupied.has(candidate)) return candidate
    sequence += 1
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  for (const char of text) {
    if (Buffer.byteLength(`${out}${char}`, 'utf8') > maxBytes) break
    out += char
  }
  return out
}
