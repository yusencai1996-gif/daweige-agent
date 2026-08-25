import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 重命名工具(M4-04):只改名字本身,不允许路径分隔符;经确认执行。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '文件/文件夹的绝对路径' }),
    new_name: Type.String({ description: '新名字(只写名字本身,不含路径)' }),
  },
  { additionalProperties: false },
)

export function createRenamePathTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'rename_path',
    label: '重命名',
    description: '给文件或文件夹改名字(只改名字,不换位置)。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const dest = await deps.ops.renamePath(params.path, params.new_name)
      return {
        content: [{ type: 'text', text: `已改名:${params.path} → ${dest}` }],
        details: { from: params.path, to: dest },
      }
    },
  }
}
