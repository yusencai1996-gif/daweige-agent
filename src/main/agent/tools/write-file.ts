import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'

/** 写文件工具(M4-04):新文件或整体覆盖写;经确认卡批准后执行。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '普通文件使用绝对路径；全局技能使用 daweige-skill://global/<name>/SKILL.md' }),
    content: Type.String({ description: '要写入的完整内容' }),
  },
  { additionalProperties: false },
)

export function createWriteFileTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'write_file',
    label: '写入文件',
    description: deps.managedSkillWriteOnly
      ? '只通过 daweige-skill://global/<name>/SKILL.md 新建纯 Markdown 全局技能；需要用户确认。'
      : deps.managedSkillWrite
        ? '写入文本文件；也可通过受控 daweige-skill:// 地址新建全局技能。需要用户确认后才会执行。'
        : '写入一个文本文件(新文件,或整体覆盖已有文件)。需要用户确认后才会执行。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const managed = deps.managedSkillWrite && deps.sessionId
        ? await deps.managedSkillWrite.resolve(params.path, params.content, deps.sessionId)
        : undefined
      if (managed && deps.managedSkillWrite && deps.sessionId) {
        await deps.managedSkillWrite.install(managed, deps.sessionId)
        const size = Buffer.byteLength(managed.markdown, 'utf8')
        return {
          content: [{
            type: 'text' as const,
            text: `已新建技能:${managed.logicalPath}(${formatSize(size)})。新建会话后可用。`,
          }],
          details: { path: managed.logicalPath, existed: false, bytes: size },
        }
      }
      if (deps.managedSkillWriteOnly) {
        throw new Error('当前会话的 write_file 只允许使用受控技能地址。')
      }
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
