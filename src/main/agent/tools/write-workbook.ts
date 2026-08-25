import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'
import { buildWorkbook } from '../../files/formats/xlsx'

/** Excel/CSV 写入工具(M4-06):写入明确值;公式可选(同时带缓存值)。 */

const CellSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
])

const SheetSchema = Type.Object(
  {
    name: Type.String({ description: '工作表名' }),
    rows: Type.Array(Type.Array(CellSchema), { description: '按行列出的数据(第一行可为表头)' }),
  },
  { additionalProperties: false },
)

const Params = Type.Object(
  {
    path: Type.String({ description: '要生成的 .xlsx/.csv 文件绝对路径' }),
    sheets: Type.Array(SheetSchema, { minItems: 1, description: '工作表数据' }),
    formulas: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: '可选公式,格式 {"A5": "=SUM(A1:A4)"};建议同时把算好的值写进 rows',
      }),
    ),
  },
  { additionalProperties: false },
)

export function createWriteWorkbookTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'write_workbook',
    label: '写入表格',
    description:
      '生成或覆盖 Excel 表格(.xlsx)/CSV 文件。数据请直接写值;需要公式时用 formulas 参数,并把算好的结果同时写进数据。需要用户确认后才会保存。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const buf = buildWorkbook(
        params.sheets.map((s) => ({ name: s.name, rows: s.rows })),
        params.formulas,
      )
      await deps.ops.writeBinary(params.path, buf)
      return {
        content: [{ type: 'text', text: `已生成表格:${params.path}(${params.sheets.length} 个工作表)` }],
        details: { path: params.path, sheets: params.sheets.length },
      }
    },
  }
}
