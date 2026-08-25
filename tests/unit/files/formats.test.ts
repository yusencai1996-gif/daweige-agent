import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../src/main/files/formats/docx-writer'
import { extractDocxText } from '../../../src/main/files/formats/docx-reader'
import { buildWorkbook, readWorkbook, parseCsv } from '../../../src/main/files/formats/xlsx'

/** M4-05/06:docx/xlsx 适配器 round-trip(生成的内容自己能读回)。 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-fmt-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('docx 适配器(M4-05)', () => {
  it('生成 → 提取:标题/段落/列表/表格文字都在', async () => {
    const buf = await buildDocx('测试文档', [
      {
        heading: '第一部分',
        paragraphs: ['这是第一段中文内容。'],
        bullets: ['要点一', '要点二'],
        table: [
          ['名称', '数量'],
          ['苹果', '3'],
        ],
      },
    ])
    expect(buf.length).toBeGreaterThan(0)
    // 保存的文件可被 Word/WPS 打开(结构合法)——这里验证 mammoth 能解析
    const text = await extractDocxText(buf)
    expect(text).toContain('测试文档')
    expect(text).toContain('这是第一段中文内容。')
    expect(text).toContain('要点一')
    expect(text).toContain('苹果')
  })
})

describe('xlsx 适配器(M4-06,含分页)', () => {
  it('生成 → 读回:多 sheet、数值、日期、空值', async () => {
    const buf = buildWorkbook([
      {
        name: '汇总',
        rows: [
          ['名称', '数量', '备注'],
          ['苹果', 3, null],
          ['香蕉', 5, '快没了'],
        ],
      },
      { name: 'Sheet2', rows: [['第二表']] },
    ])
    const summary = readWorkbook(buf)
    expect(summary.sheets.map((s) => s.name)).toEqual(['汇总', 'Sheet2'])
    const rows = summary.sheets[0]!.previewRows
    expect(rows[1]).toEqual(['苹果', 3, null])
    expect(rows[2]).toEqual(['香蕉', 5, '快没了'])
  })

  it('分页:start_row + max_rows 只取窗口,超大表可翻页读完(复审 B-04)', () => {
    const big: (string | number)[][] = [['行号']]
    for (let i = 0; i < 550; i++) big.push([i])
    const buf = buildWorkbook([{ name: '大表', rows: big }])
    const page1 = readWorkbook(buf, { maxRows: 200 })
    expect(page1.sheets[0]!.rowCount).toBe(551)
    expect(page1.sheets[0]!.previewRows).toHaveLength(200)
    const page3 = readWorkbook(buf, { offsetRows: 400, maxRows: 200 })
    expect(page3.sheets[0]!.previewRows).toHaveLength(151)
    expect(page3.sheets[0]!.previewRows[0]).toEqual([399])
  })

  it('公式写入(带缓存值思路:值在 rows,公式在 formulas)', async () => {
    const buf = buildWorkbook(
      [{ name: '计算', rows: [['数值', '合计'], [1, null], [2, null], [null, 3]] }],
      { B4: '=SUM(B2:B3)' },
    )
    expect(buf.length).toBeGreaterThan(0)
    const again = readWorkbook(buf)
    expect(again.sheets[0]!.previewRows[3]![1]).toBe(3)
  })

  it('CSV 解析:引号/逗号/换行', async () => {
    const csv = '名称,备注\n"带,逗号","含""引号"\n普通,行\n'
    const rows = parseCsv(csv)
    expect(rows[1]).toEqual(['带,逗号', '含"引号'])
    expect(rows[2]).toEqual(['普通', '行'])
  })

  it('readWorkbook 直接吃 csv 文件内容', async () => {
    const p = join(dir, 'data.csv')
    await writeFile(p, 'a,b\n1,2\n', 'utf-8')
    const { readFileSync } = await import('node:fs')
    const summary = readWorkbook(readFileSync(p))
    expect(summary.sheets[0]!.rowCount).toBe(2)
  })
})
