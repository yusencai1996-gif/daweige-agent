import * as XLSX from 'xlsx'

/**
 * Excel/CSV 适配器(M4-06,SheetJS CE,Apahe-2.0,归属见 THIRD-PARTY-NOTICES)。
 * 汇总结果写入明确数值(应用/模型算好),需要公式时同时带缓存值(R-11)。
 */

export interface SheetData {
  name: string
  /** 行数据;单元格为 string | number | boolean | null。 */
  rows: (string | number | boolean | null)[][]
}

export interface WorkbookSummary {
  sheets: {
    name: string
    rowCount: number
    /** 当前窗口的数据行(分页读取;offsetRows/maxRows 控制)。 */
    previewRows: (string | number | boolean | null)[][]
    /** 本窗口第一行在全文中的行号(0 基)。 */
    offsetRows: number
  }[]
}

export function readWorkbook(
  buf: Buffer,
  opts: { sheetName?: string; offsetRows?: number; maxRows?: number } = {},
): WorkbookSummary {
  const wb = XLSX.read(buf, { cellDates: true })
  const maxRows = Math.min(Math.max(opts.maxRows ?? 200, 1), 2000)
  const offsetRows = Math.max(opts.offsetRows ?? 0, 0)
  return {
    sheets: wb.SheetNames.map((name) => {
      if (opts.sheetName !== undefined && name !== opts.sheetName) {
        return { name, rowCount: -1, previewRows: [], offsetRows: 0 }
      }
      const sheet = wb.Sheets[name]!
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: null,
        raw: true,
      }) as (string | number | boolean | null)[][]
      return {
        name,
        rowCount: rows.length,
        previewRows: rows.slice(offsetRows, offsetRows + maxRows),
        offsetRows,
      }
    }).filter((s) => s.rowCount >= 0),
  }
}

export function buildWorkbook(sheets: SheetData[], formulas?: Record<string, string>): Buffer {
  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const aoa = sheet.rows.map((row) => [...row])
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // 可选公式写入(单元格地址 → 公式字符串,如 "A5": "SUM(A1:A4)")
    for (const [addr, formula] of Object.entries(formulas ?? {})) {
      const cell = ws[addr as keyof typeof ws] as { f?: string; t?: string } | undefined
      if (cell) {
        cell.f = formula
      } else {
        ws[addr as keyof typeof ws] = { t: 'n', f: formula, v: undefined } as never
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, sheet.name)
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
  return Buffer.from(out as ArrayBuffer)
}

/** CSV 快速预览(读小 CSV 用 readText 即可,这里给分列预览)。 */
export function parseCsv(text: string, maxRows = 50): string[][] {
  const wb = XLSX.read(text, { type: 'string', raw: true })
  const first = wb.SheetNames[0]
  if (!first) return []
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first]!, {
    header: 1,
    blankrows: false,
  }) as unknown[][]
  return rows.slice(0, maxRows).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))))
}
