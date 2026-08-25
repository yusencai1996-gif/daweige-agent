import { memo, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  findCommitBoundary,
  looksLikeMarkdown,
  safeUrlTransform,
  splitBlocks,
} from './markdown-stream'

/** 链接统一新窗口打开、禁回链;urlTransform 已剥掉 javascript: 等危险协议。 */
const mdComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

function MarkdownBlock({ text }: { readonly text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={safeUrlTransform}
      components={mdComponents}
    >
      {text}
    </ReactMarkdown>
  )
}

/** 已提交稳定块:内容不变就不重解析(memo 以字符串相等为命中)。 */
const StableBlock = memo(MarkdownBlock)

interface StreamState {
  /** 上一次处理的完整文本。 */
  readonly text: string
  /** 稳定前缀的提交边界(只前进)。 */
  readonly boundary: number
  /** 已提交的顶层块。 */
  readonly blocks: readonly string[]
}

const INITIAL_STREAM_STATE: StreamState = { text: '', boundary: 0, blocks: [] }

/**
 * 流式 Markdown 渲染:
 * - 纯文本走快路径,不做任何 Markdown 解析;
 * - 已完成的顶层块进稳定前缀,逐块 memo,不再重解析;
 * - 每个增量只重解析尾部未闭合块;切分边界只前进不回退。
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  text,
}: {
  readonly text: string
}) {
  const prevRef = useRef<StreamState>(INITIAL_STREAM_STATE)

  const view = useMemo((): StreamState => {
    let prev = prevRef.current
    // 换消息或文本被重置(不再是已提交前缀的延伸)时从头来。
    if (!text.startsWith(prev.text.slice(0, prev.boundary))) {
      prev = INITIAL_STREAM_STATE
    }
    const boundary = findCommitBoundary(text, prev.boundary)
    const blocks =
      boundary > prev.boundary
        ? [...prev.blocks, ...splitBlocks(text.slice(prev.boundary, boundary))]
        : prev.blocks
    const next: StreamState = { text, boundary, blocks }
    prevRef.current = next
    return next
  }, [text])

  if (!looksLikeMarkdown(text)) {
    return <div className="md-plain">{text}</div>
  }

  const tail = text.slice(view.boundary)
  return (
    <div className="md-body">
      {view.blocks.map((block, index) => (
        <StableBlock key={`${index}:${block.length}`} text={block} />
      ))}
      {tail.trim().length > 0 && <MarkdownBlock text={tail} />}
    </div>
  )
})
