import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 写文件工具(M4-04):新文件或整体覆盖写;经确认卡批准后执行。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '目标文件的绝对路径' }),
    content: Type.String({ description: '要写入的完整内容' }),
  },
  { additionalProperties: false },
)

export function createWriteFileTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'write_file',
    label: '写入文件',
    description: '写入一个文本文件(新文件,或整体覆盖已有文件)。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const existed = await deps.ops.fileExists(params.path)
      await deps.ops.writeText(params.path, params.content)
      const size = Buffer.byteLength(params.content, 'utf-8')
      return {
        content: [
          {
            type: 'text',
            text: existed
              ? `已覆盖写入:${params.path}(${formatSize(size)})`
              : `已新建文件:${params.path}(${formatSize(size)})`,
          },
        ],
        details: { path: params.path, existed, bytes: size },
      }
    },
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`
}
