import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDeps } from './deps'
import { readWorkbook } from '../../files/formats/xlsx'

/** Excel/CSV 读取工具(M4-06,复审整改 B-04):分页读取,默认 200 行,可翻页到全表。 */

const Params = Type.Object(
  {
    path: Type.String({ description: '.xlsx 或 .csv 文件的绝对路径' }),
    sheet_name: Type.Optional(Type.String({ description: '工作表名(不填读第一个)' })),
    start_row: Type.Optional(Type.Integer({ minimum: 0, description: '从第几行开始读(0 基,默认 0)' })),
    max_rows: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 2000, description: '本次最多读多少行(默认 200,上限 2000)' }),
    ),
  },
  { additionalProperties: false },
)

export function createReadWorkbookTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'read_workbook',
    label: '读取表格',
    description:
      '读取 Excel 表格(.xlsx)或 CSV,返回工作表行列数和指定范围的数据。默认从第 0 行起读 200 行;' +
      '表更大时按返回提示用 start_row 继续翻页,务必把全部数据读完再做汇总,不要只凭前几行下结论。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      const buf = await deps.ops.readBinary(params.path)
      const summary = readWorkbook(buf, {
        ...(params.sheet_name !== undefined ? { sheetName: params.sheet_name } : {}),
        offsetRows: params.start_row ?? 0,
        maxRows: params.max_rows ?? 200,
      })
      const lines: string[] = []
      for (const sheet of summary.sheets) {
        const start = sheet.offsetRows
        const end = start + sheet.previewRows.length
        lines.push(`# 工作表「${sheet.name}」共 ${sheet.rowCount} 行,当前显示第 ${start}~${end - 1} 行`)
        for (const row of sheet.previewRows) {
          lines.push(row.map((c) => (c === null ? '' : String(c))).join(' | '))
        }
        if (end < sheet.rowCount) {
          lines.push(`(还有 ${sheet.rowCount - end} 行没读:把 start_row 设为 ${end} 继续读)`)
        }
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          path: params.path,
          sheets: summary.sheets.map((s) => ({ name: s.name, rowCount: s.rowCount })),
        },
      }
    },
  }
}
