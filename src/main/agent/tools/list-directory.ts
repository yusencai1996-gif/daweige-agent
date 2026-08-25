import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 目录列表工具(M4-03):名字/类型/大小,给模型看文件夹结构。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '文件夹的绝对路径' }),
  },
  { additionalProperties: false },
)

export function createListDirectoryTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'list_directory',
    label: '查看文件夹',
    description: '列出一个文件夹里的所有文件和子文件夹(名字、类型、大小、修改时间)。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const items = await deps.ops.listDirectory(params.path)
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: '这个文件夹是空的。' }],
          details: { path: params.path, count: 0 },
        }
      }
      const lines = items.map((it) =>
        it.type === 'directory'
          ? `[文件夹] ${it.name}`
          : `[文件] ${it.name}(${formatSize(it.size)})`,
      )
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { path: params.path, count: items.length },
      }
    },
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
