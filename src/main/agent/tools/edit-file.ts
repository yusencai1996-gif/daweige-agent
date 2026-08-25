import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 精确编辑工具(M4-04):old_string 必须唯一匹配,替换为 new_string;经确认执行。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '文件的绝对路径' }),
    old_string: Type.String({ description: '要替换的原文片段,必须在全文中唯一出现' }),
    new_string: Type.String({ description: '替换后的新内容' }),
  },
  { additionalProperties: false },
)

export function createEditFileTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'edit_file',
    label: '编辑文件',
    description:
      '修改文本文件的一小部分:找到唯一的原文片段并替换。原文片段要足够长以保证唯一。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      await deps.ops.editText(params.path, params.old_string, params.new_string)
      return {
        content: [{ type: 'text', text: `已修改:${params.path}` }],
        details: { path: params.path },
      }
    },
  }
}
