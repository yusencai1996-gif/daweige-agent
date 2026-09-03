import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { MemoryDate, MemorySource } from '../../../shared/domain/memory'
import type { GlobalMemoryStore } from '../../memory/global-memory-store'
import { assertValidMemoryDate } from '../../memory/memory-date'

const DateSchema = Type.Union([
  Type.Object({ kind: Type.Literal('recurring'), month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fixed'), iso: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) }, { additionalProperties: false }),
])
const AddNoteParams = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 20 * 1024 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  category: Type.Optional(Type.String({ maxLength: 100 })),
  date: Type.Optional(DateSchema),
}, { additionalProperties: false })
const SearchParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false })
const ReadParams = Type.Object({
  path: Type.String({ pattern: '^(?:MEMORY\\.md|notes/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]{0,79}\\.md)$' }),
  lineStart: Type.Optional(Type.Integer({ minimum: 1 })), lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false })
const SaveParams = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 20 * 1024 }), title: Type.String({ minLength: 1, maxLength: 200 }),
  category: Type.Optional(Type.String({ maxLength: 100 })), date: Type.Optional(DateSchema),
}, { additionalProperties: false })

export function createAddMemoryNoteTool(store: GlobalMemoryStore, source: MemorySource): AgentTool<typeof AddNoteParams> {
  return { name: 'memory.add_note', label: '添加记忆', description: '把一条权威原始记忆追加到全局记忆库。传 text，可选 title/category/date；文件名由应用生成。更新或忘记旧信息时也追加说明，不改写旧条目。', parameters: AddNoteParams, executionMode: 'sequential',
    execute: async (_id, params: Static<typeof AddNoteParams>) => {
      if (params.date !== undefined) assertValidMemoryDate(params.date)
      const entry = await store.addGeneratedNote({
        text: params.text,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.category !== undefined ? { category: params.category } : {}),
        ...(params.date !== undefined ? { date: params.date as MemoryDate } : {}),
      }, source)
      return { content: [{ type: 'text', text: `已追加记忆:${entry.id}` }], details: { id: entry.id } }
    } }
}

export function createMemorySearchTool(store: GlobalMemoryStore, name = 'memory.search'): AgentTool<typeof SearchParams> {
  return { name, label: '检索记忆', description: '按一个或多个关键词检索全局记忆，返回带逻辑路径和行号的上下文窗口。', parameters: SearchParams, executionMode: 'sequential',
    execute: async (_id, params: Static<typeof SearchParams>) => {
      const hits = await store.search(params.query, params.maxResults)
      const text = hits.length === 0 ? '记忆库里没有相关记录。' : hits.map((hit) => `${hit.path}:${hit.lineStart}-${hit.lineEnd}\n${hit.excerpt}`).join('\n\n')
      return { content: [{ type: 'text', text }], details: { count: hits.length } }
    } }
}

export function createMemoryReadTool(store: GlobalMemoryStore): AgentTool<typeof ReadParams> {
  return { name: 'memory.read', label: '读取记忆', description: '按逻辑路径和行号读取 MEMORY.md 或已登记的原始记忆条目。', parameters: ReadParams, executionMode: 'sequential',
    execute: async (_id, params: Static<typeof ReadParams>) => {
      const result = await store.read(params.path, params.lineStart, params.lineEnd)
      return { content: [{ type: 'text', text: `${result.path}:${result.lineStart}-${result.lineEnd}${result.truncated ? '（已截断）' : ''}\n${result.content}` }], details: result }
    } }
}

export function createSaveMemoryTool(store: GlobalMemoryStore, source: MemorySource): AgentTool<typeof SaveParams> {
  return { name: 'save_memory', label: '记事', description: '兼容旧守则：保存生活记事；含日期时提取日期。', parameters: SaveParams, executionMode: 'sequential',
    execute: async (_id, params: Static<typeof SaveParams>) => {
      if (params.date !== undefined) assertValidMemoryDate(params.date)
      const entry = await store.addGeneratedNote({ text: params.text, title: params.title, category: params.category ?? '事实', ...(params.date ? { date: params.date as MemoryDate } : {}) }, source)
      return { content: [{ type: 'text', text: `已保存记事:${entry.title ?? params.title}。请向用户确认“已记住”。` }], details: { id: entry.id } }
    } }
}

export function createSearchMemoriesTool(store: GlobalMemoryStore): AgentTool<typeof SearchParams> { return createMemorySearchTool(store, 'search_memories') }
export function createMemoryTools(store: GlobalMemoryStore, source: MemorySource): AgentTool[] {
  return [createAddMemoryNoteTool(store, source), createMemorySearchTool(store), createMemoryReadTool(store), createSaveMemoryTool(store, source), createSearchMemoriesTool(store)]
}
