import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'
import { buildDocx, type DocxSection } from '../../files/formats/docx-writer'

/** Word 生成工具(M4-05):标题+段落/列表/表格;生成的文件可被 Word/WPS 打开。 */

const SectionSchema = Type.Object(
  {
    heading: Type.Optional(Type.String({ description: '小节标题' })),
    paragraphs: Type.Optional(Type.Array(Type.String(), { description: '段落列表' })),
    bullets: Type.Optional(Type.Array(Type.String(), { description: '项目符号列表' })),
    table: Type.Optional(Type.Array(Type.Array(Type.String()), { description: '表格(第一行为表头)' })),
  },
  { additionalProperties: false },
)

const Params = Type.Object(
  {
    path: Type.String({ description: '要生成的 .docx 文件绝对路径' }),
    title: Type.String({ description: '文档标题' }),
    sections: Type.Array(SectionSchema, { minItems: 1, description: '文档内容分节' }),
  },
  { additionalProperties: false },
)

export function createWriteDocxTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'write_docx',
    label: '生成 Word 文档',
    description:
      '生成 Word 文档(.docx):支持标题、段落、项目符号列表和简单表格。需要用户确认后才会保存。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const buf = await buildDocx(
        params.title,
        params.sections as DocxSection[],
      )
      await deps.ops.writeBinary(params.path, buf)
      return {
        content: [{ type: 'text', text: `已生成 Word 文档:${params.path}(${Math.round(buf.length / 1024)}KB)` }],
        details: { path: params.path, bytes: buf.length },
      }
    },
  }
}
