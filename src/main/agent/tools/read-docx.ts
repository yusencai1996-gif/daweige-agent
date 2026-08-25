import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'
import { extractDocxText } from '../../files/formats/docx-reader'

/** Word 读取工具(M4-05):mammoth 提取纯文本。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '.docx 文件的绝对路径' }),
  },
  { additionalProperties: false },
)

export function createReadDocxTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'read_docx',
    label: '读取 Word 文档',
    description: '读取 Word 文档(.docx)的文字内容(标题、段落、列表、表格文字)。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const buf = await deps.ops.readBinary(params.path)
      const text = await extractDocxText(buf)
      if (text.length > 500_000) {
        return {
          content: [
            { type: 'text', text: `文档很长(约 ${text.length} 字),以下只取前 50 万字:\n${text.slice(0, 500_000)}` },
          ],
          details: { path: params.path, length: text.length },
        }
      }
      return {
        content: [{ type: 'text', text }],
        details: { path: params.path, length: text.length },
      }
    },
  }
}
