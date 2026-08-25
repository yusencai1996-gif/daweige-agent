import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { MemoryStore } from '../../memory/memory-store'
import type { MemoryDate } from '../../../shared/domain/memory'

/**
 * 记事工具(M5-02)。
 * save_memory 写应用内部数据(userData/data/memories.json),免确认卡(PLAN 明确);
 * 保存成功由模型在回复中口头确认("已记住:××")。
 */

const DateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('recurring'),
      month: Type.Integer({ minimum: 1, maximum: 12, description: '月(1-12)' }),
      day: Type.Integer({ minimum: 1, maximum: 31, description: '日(1-31)' }),
    },
    { additionalProperties: false, description: '每年重复:生日/纪念日' },
  ),
  Type.Object(
    {
      kind: Type.Literal('fixed'),
      iso: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '一次性日期 YYYY-MM-DD' }),
    },
    { additionalProperties: false, description: '一次性日期' },
  ),
])

const SaveParams = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000, description: '用户要记住的原话,如"我妈生日是三月五号"' }),
    title: Type.String({ minLength: 1, maxLength: 40, description: '提炼的短标题,如"妈妈生日"(提醒时显示)' }),
    category: Type.Optional(Type.String({ maxLength: 20, description: '类别:生日/纪念日/偏好/事实' })),
    date: Type.Optional(DateSchema),
  },
  { additionalProperties: false },
)

export function createSaveMemoryTool(store: MemoryStore): AgentTool<typeof SaveParams> {
  return {
    name: 'save_memory',
    label: '记事',
    description:
      '把用户说的重要事情记到本地记事本(生日、纪念日、偏好等)。含日期的事记得提取日期:生日/周年用 recurring(月+日),一次性安排用 fixed。保存后告诉用户"已记住:××"。',
    parameters: SaveParams,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof SaveParams>) => {
      const entry = await store.add({
        text: params.text,
        title: params.title,
        category: params.category ?? '事实',
        ...(params.date ? { date: params.date as MemoryDate } : {}),
      })
      return {
        content: [
          { type: 'text', text: `已保存记事:${entry.title}(类别:${entry.category})。请在回复里向用户口头确认"已记住"。` },
        ],
        details: { id: entry.id },
      }
    },
  }
}

const SearchParams = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200, description: '要查的关键词,如"妈妈生日"' }),
  },
  { additionalProperties: false },
)

export function createSearchMemoriesTool(store: MemoryStore): AgentTool<typeof SearchParams> {
  return {
    name: 'search_memories',
    label: '查记事',
    description: '按关键词查本地记事本。用户问"我妈生日是什么时候"这类事之前先查一查。',
    parameters: SearchParams,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof SearchParams>) => {
      const found = await store.search(params.query)
      if (found.length === 0) {
        return {
          content: [{ type: 'text', text: '记事本里没有相关记录。' }],
          details: { count: 0 },
        }
      }
      const lines = found.map((m) => {
        const date = m.date
          ? m.date.kind === 'recurring'
            ? `每年 ${m.date.month} 月 ${m.date.day} 日`
            : m.date.iso
          : '无日期'
        return `· ${m.title}(${m.category},${date}):${m.text}`
      })
      return {
        content: [{ type: 'text', text: `找到 ${found.length} 条:\n${lines.join('\n')}` }],
        details: { count: found.length },
      }
    },
  }
}

export function createMemoryTools(store: MemoryStore): AgentTool[] {
  return [createSaveMemoryTool(store), createSearchMemoriesTool(store)]
}
