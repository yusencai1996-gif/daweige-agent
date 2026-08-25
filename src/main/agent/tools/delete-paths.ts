import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'
import { formatBatchResult } from './move-paths'

/**
 * 批量删除工具(M4-04):走 Windows 回收站(可恢复);经确认执行。
 * trash 由外部注入(Electron shell.trashItem),测试可换假实现。
 */

const Params = Type.Object(
  {
    paths: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 500,
      description: '要删除的文件/文件夹的绝对路径列表',
    }),
  },
  { additionalProperties: false },
)

export function createDeletePathsTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'delete_paths',
    label: '删除文件',
    description:
      '把文件或文件夹放进 Windows 回收站(删错还能找回)。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const results = await deps.ops.deletePaths(params.paths, deps.trash)
      return formatBatchResult(results, '删除')
    },
  }
}
