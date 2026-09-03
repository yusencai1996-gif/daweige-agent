import { formatCount } from './skill-display'

interface SkillMarkdownPreviewProps {
  /** 已打码的 Markdown 预览正文(契约保证 ≤64 KiB)。 */
  readonly content: string
  /** 完整正文字节数;缺省时不显示字节信息。 */
  readonly totalBytes?: number | undefined
  /** true=预览只是开头+结尾,中间有省略,渲染明确截断标记。 */
  readonly truncated?: boolean
}

/**
 * 技能 Markdown 正文预览(0.7.0 A2/B1 共用):等宽、可滚动、永不横向撑破(pre-wrap)。
 * 截断态把头尾分两段渲染,中间放明确截断标记;批准对象仍绑定完整内容(后端职责),
 * 这里只负责如实告诉用户「看的不是全部」。
 */
export function SkillMarkdownPreview({ content, totalBytes, truncated = false }: SkillMarkdownPreviewProps) {
  const midpoint = Math.floor(content.length / 2)
  const head = truncated ? content.slice(0, midpoint) : content
  const tail = truncated ? content.slice(midpoint) : ''
  return (
    <>
      {totalBytes !== undefined && (
        <div className="approval-markdown-info">
          正文共 {formatCount(totalBytes)} 字节
          {truncated ? ',以下只展示开头和结尾' : ',全文如下'}
        </div>
      )}
      <div className="approval-markdown" tabIndex={0} aria-label="技能正文 Markdown 预览">
        <pre>
          <code>{head}</code>
        </pre>
        {truncated && (
          <>
            <div className="approval-truncate-marker" role="note">
              —— 中间内容已省略 ——
            </div>
            <pre>
              <code>{tail}</code>
            </pre>
          </>
        )}
      </div>
    </>
  )
}
