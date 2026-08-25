import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 读取文本文件工具(M4-03):txt/md/csv,工作区内免确认。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '文件的绝对路径' }),
  },
  { additionalProperties: false },
)

export function createReadFileTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'read_file',
    label: '读取文件',
    description: '读取一个文本文件(txt/md/csv)的内容。用于查看文件内容、搜索文本。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const text = await deps.ops.readText(params.path)
      return { content: [{ type: 'text', text }], details: { path: params.path } }
    },
  }
}
