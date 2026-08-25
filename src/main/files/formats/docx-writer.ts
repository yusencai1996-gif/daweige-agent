import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

/** Word 生成适配器(M4-05):标题/段落/列表/简单表格。 */

export interface DocxSection {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
  table?: string[][]
}

export async function buildDocx(title: string, sections: DocxSection[]): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ]
  for (const section of sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }))
    }
    for (const p of section.paragraphs ?? []) {
      children.push(new Paragraph({
        children: [new TextRun({ text: p, size: 24 })], // 12pt
        alignment: AlignmentType.LEFT,
      }))
    }
    for (const b of section.bullets ?? []) {
      children.push(new Paragraph({ text: b, bullet: { level: 0 } }))
    }
    if (section.table && section.table.length > 0) {
      children.push(buildTable(section.table))
    }
  }
  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}

function buildTable(rows: string[][]): Table {
  const tableRows = rows.map((cells) =>
    new TableRow({
      children: cells.map(
        (text) =>
          new TableCell({
            width: { size: Math.floor(100 / Math.max(cells.length, 1)), type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text, size: 22 })] })],
          }),
      ),
    }),
  )
  return new Table({ rows: tableRows })
}
