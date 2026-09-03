import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Value } from 'typebox/value'
import type { FileOps } from '../../../src/main/files/file-ops'
import { createWritePptxTool, validateSlideTextBudget } from '../../../src/main/agent/tools/write-pptx'

describe('write_pptx', () => {
  it('E-9 Unicode 画布预算覆盖标题建议/硬限、emoji、单条/总量/section，超限不写文件', async () => {
    expect(() => validateSlideTextBudget([{ title: '中'.repeat(60), bullets: ['😀'.repeat(120)] }])).not.toThrow()
    expect(() => validateSlideTextBudget([{ title: '中'.repeat(100), bullets: [] }])).not.toThrow()
    expect(() => validateSlideTextBudget([{ title: '中'.repeat(101), bullets: [] }])).toThrow('100 字')
    expect(() => validateSlideTextBudget([{ title: '标题', bullets: ['😀'.repeat(121)] }])).toThrow('120 字')
    expect(() => validateSlideTextBudget([{ title: '标题', bullets: Array.from({ length: 5 }, () => '中'.repeat(100)) }])).toThrow('480 字')
    expect(() => validateSlideTextBudget([{ title: '中'.repeat(100), bullets: ['中'.repeat(140)], layout_hint: 'section-title' }])).toThrow('120 字')
    expect(() => validateSlideTextBudget([{ title: '中'.repeat(100), bullets: ['中'.repeat(120), '中'.repeat(21)], layout_hint: 'section-title' }])).toThrow('240 字')
    let writes = 0
    const tool = createWritePptxTool(fakeDeps(() => { writes += 1 }))
    await expect(tool.execute('over', { path: 'C:\\work\\over.pptx', slides: [{ title: '中'.repeat(101), bullets: [] }] })).rejects.toThrow('拆短')
    expect(writes).toBe(0)
  })

  it('E-10 工具说明明确不能读取/局部修改旧 PPT，且没有 read_pptx 能力', () => {
    const tool = createWritePptxTool(fakeDeps(() => {}))
    expect(tool.description).toContain('不能读取或局部修改已有 PPT')
    expect(tool.description).toContain('不得声称看过旧文件')
  })
  it('schema 限制额外参数、30 片与每片 8 条要点', () => {
    const tool = createWritePptxTool(fakeDeps(() => {}))
    const schema = tool.parameters
    const slide = { title: '标题', bullets: ['要点'] }
    expect(Value.Check(schema, { path: 'C:\\work\\demo.pptx', slides: [slide] })).toBe(true)
    expect(Value.Check(schema, { path: 'C:\\work\\demo.pptx', slides: [slide], extra: true })).toBe(false)
    expect(Value.Check(schema, { path: 'C:\\work\\demo.txt', slides: [slide] })).toBe(false)
    expect(Value.Check(schema, {
      path: 'C:\\work\\demo.pptx',
      slides: [{ title: '标题', bullets: Array.from({ length: 9 }, (_, i) => `要点${i}`) }],
    })).toBe(false)
    expect(Value.Check(schema, {
      path: 'C:\\work\\demo.pptx',
      slides: Array.from({ length: 31 }, () => slide),
    })).toBe(false)
  })

  it('生成的二进制是可解析的 Office Open XML 演示文稿,含幻灯片和备注', async () => {
    let writtenPath = ''
    let written = new Uint8Array()
    const tool = createWritePptxTool(fakeDeps((path, data) => {
      writtenPath = path
      written = Uint8Array.from(data)
    }))

    const result = await tool.execute('call-1', {
      path: 'C:\\work\\成果.pptx',
      slides: [
        { title: '季度总结', bullets: ['收入增长', '成本受控'], notes: '先讲收入。' },
        { title: '下一步', bullets: [], layout_hint: 'title-only' },
      ],
    })

    expect(writtenPath).toBe('C:\\work\\成果.pptx')
    expect(written.byteLength).toBeGreaterThan(1_000)
    const zip = await JSZip.loadAsync(written)
    expect(zip.file('[Content_Types].xml')).not.toBeNull()
    expect(zip.file('ppt/presentation.xml')).not.toBeNull()
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull()
    expect(zip.file('ppt/slides/slide2.xml')).not.toBeNull()
    expect(Object.keys(zip.files).some((name) => name.startsWith('ppt/notesSlides/notesSlide'))).toBe(true)
    expect(result.details).toMatchObject({ path: writtenPath, slides: 2, bytes: written.byteLength })
  })
})

function fakeDeps(write: (path: string, data: Uint8Array) => void) {
  return {
    ops: {
      writeBinary: async (path: string, data: Uint8Array) => { write(path, data) },
    } as FileOps,
    trash: async () => {},
  }
}
