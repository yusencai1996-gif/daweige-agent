import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 新建文件夹工具(M4-04):递归创建;经确认执行。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '要创建的文件夹的绝对路径' }),
  },
  { additionalProperties: false },
)

export function createMakeDirectoryTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'make_directory',
    label: '新建文件夹',
    description: '新建一个文件夹(可以一次建多级)。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      await deps.ops.makeDirectory(params.path)
      return {
        content: [{ type: 'text', text: `已创建文件夹:${params.path}` }],
        details: { path: params.path },
      }
    },
  }
}
