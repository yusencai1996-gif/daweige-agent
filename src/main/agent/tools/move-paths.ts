import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 批量移动工具(M4-04):先全量预检,确认后逐项执行,返回逐项结果。 */

const Params = Type.Object(
  {
    paths: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 500,
      description: '要移动的文件/文件夹的绝对路径列表',
    }),
    destination_dir: Type.String({ description: '目标文件夹的绝对路径' }),
  },
  { additionalProperties: false },
)

export function createMovePathsTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'move_paths',
    label: '移动文件',
    description:
      '把一批文件或文件夹移动到指定文件夹。移动整个文件、不改动内容。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const results = await deps.ops.movePaths(params.paths, params.destination_dir)
      return formatBatchResult(results, '移动')
    },
  }
}

export function formatBatchResult(
  results: { path: string; ok: boolean; error?: string }[],
  verb: string,
): AgentToolResult<{ results: typeof results }> {
  const okCount = results.filter((r) => r.ok).length
  const failCount = results.length - okCount
  if (failCount === 0) {
    return {
      content: [{ type: 'text', text: `已${verb} ${okCount} 项,全部成功。` }],
      details: { results },
    }
  }
  const failedLines = results
    .filter((r) => !r.ok)
    .map((r) => `${r.path}:${r.error}`)
    .join('\n')
  return {
    content: [
      {
        type: 'text',
        text: `${verb}完成:${okCount} 项成功,${failCount} 项失败。失败明细:\n${failedLines}`,
      },
    ],
    details: { results },
  }
}
