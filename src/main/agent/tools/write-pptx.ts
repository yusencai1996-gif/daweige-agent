import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import PptxGenJS from 'pptxgenjs'
import type { ToolDeps } from './deps'

/** PowerPoint 生成工具(A-30):标题、要点、备注与三种简单版式。 */

const SlideSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200, description: '幻灯片标题' }),
    bullets: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
      maxItems: 8,
      description: '要点列表,最多 8 条;纯标题页可传空数组',
    }),
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: '演讲者备注' })),
    layout_hint: Type.Optional(Type.Union([
      Type.Literal('title-and-bullets'),
      Type.Literal('section-title'),
      Type.Literal('title-only'),
    ], { description: '可选版式提示;默认标题加要点' })),
  },
  { additionalProperties: false },
)

const Params = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 2_048,
      pattern: '\\.[pP][pP][tT][xX]$',
      description: '要生成的 .pptx 文件绝对路径',
    }),
    slides: Type.Array(SlideSchema, { minItems: 1, maxItems: 30, description: '幻灯片列表,最多 30 片' }),
  },
  { additionalProperties: false },
)

type SlideInput = Static<typeof SlideSchema>

/** 画布预算按 Unicode code point 计数，备注不计入。 */
export function validateSlideTextBudget(slides: readonly SlideInput[]): void {
  for (const [index, slide] of slides.entries()) {
    const number = index + 1
    const titleLength = unicodeLength(slide.title)
    if (titleLength > 100) throw new Error(`第 ${number} 片标题超过 100 字硬上限，请拆短后再生成（建议不超过 60 字）。`)
    for (const [bulletIndex, bullet] of slide.bullets.entries()) {
      if (unicodeLength(bullet) > 120) throw new Error(`第 ${number} 片第 ${bulletIndex + 1} 条要点超过 120 字，请拆成多条或多片。`)
    }
    const bulletTotal = slide.bullets.reduce((sum, bullet) => sum + unicodeLength(bullet), 0)
    if (bulletTotal > 480) throw new Error(`第 ${number} 片要点合计超过 480 字，请拆成多片后再生成。`)
    if ((slide.layout_hint ?? 'title-and-bullets') === 'section-title' && titleLength + bulletTotal > 240) {
      throw new Error(`第 ${number} 片章节页画布文字超过 240 字，请精简或拆片。`)
    }
  }
}

function unicodeLength(value: string): number { return [...value].length }

export function createWritePptxTool(deps: ToolDeps): AgentTool<typeof Params> {
  return {
    name: 'write_pptx',
    label: '生成演示文稿',
    description:
      '只能根据用户提供的内容新建或覆盖 PowerPoint 演示文稿(.pptx)，不能读取或局部修改已有 PPT，也不得声称看过旧文件；要改旧 PPT 时先索取源文字/大纲并另存新文件。每片支持标题、最多 8 条要点、备注和简单版式，最多 30 片。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof Params>) => {
      validateSlideTextBudget(params.slides)
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_WIDE'
      pptx.author = '大微阁'
      pptx.subject = '大微阁生成的演示文稿'
      pptx.title = params.slides[0]?.title ?? ''
      pptx.theme = {
        headFontFace: 'Microsoft YaHei',
        bodyFontFace: 'Microsoft YaHei',
      }

      for (const item of params.slides) {
        const slide = pptx.addSlide()
        slide.background = { color: 'F7F4EC' }
        const hint = item.layout_hint ?? 'title-and-bullets'
        if (hint === 'section-title') {
          slide.addText(item.title, {
            x: 1.1, y: 2.35, w: 11.1, h: 1.0,
            fontFace: 'Microsoft YaHei', fontSize: 30, bold: true,
            color: '263530', align: 'center', valign: 'middle', margin: 0,
          })
          if (item.bullets.length > 0) {
            slide.addText(item.bullets.join(' · '), {
              x: 1.4, y: 3.55, w: 10.5, h: 0.65,
              fontFace: 'Microsoft YaHei', fontSize: 16,
              color: '66716A', align: 'center', valign: 'middle', margin: 0,
            })
          }
        } else {
          slide.addText(item.title, {
            x: 0.8, y: 0.55, w: 11.7, h: 0.65,
            fontFace: 'Microsoft YaHei', fontSize: 26, bold: true,
            color: '263530', margin: 0,
          })
          slide.addShape(pptx.ShapeType.line, {
            x: 0.8, y: 1.35, w: 1.0, h: 0,
            line: { color: 'A65349', width: 2.5 },
          })
          if (hint !== 'title-only' && item.bullets.length > 0) {
            slide.addText(item.bullets.map((text) => ({
              text,
              options: { bullet: { indent: 18 }, breakLine: true },
            })), {
              x: 1.05, y: 1.75, w: 11.1, h: 4.8,
              fontFace: 'Microsoft YaHei', fontSize: 20,
              color: '263530', breakLine: false, margin: 0.08,
              paraSpaceAfter: 15, valign: 'top',
            })
          }
        }
        if (item.notes !== undefined) slide.addNotes(item.notes)
      }

      // pptxgenjs 的 write() 分支会丢弃 compression(仅 STREAM 分支走 DEFLATE);stream() 压缩且同样返回 nodebuffer
      const output = await pptx.stream({ compression: true })
      if (!(output instanceof Uint8Array)) {
        throw new Error('演示文稿生成失败:输出格式异常')
      }
      await deps.ops.writeBinary(params.path, output)
      return {
        content: [{
          type: 'text',
          text: `已生成演示文稿:${params.path}(${params.slides.length} 片,${Math.round(output.byteLength / 1024)}KB)`,
        }],
        details: { path: params.path, slides: params.slides.length, bytes: output.byteLength },
      }
    },
  }
}
