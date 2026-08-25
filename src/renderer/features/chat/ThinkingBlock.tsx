import { useEffect, useState } from 'react'

interface ThinkingBlockProps {
  /** 思考全文(流式累计或历史恢复)。 */
  readonly thinking: string
  /** 流式中默认展开,流式结束(message_end)自动折叠;历史消息传 false 默认折叠。 */
  readonly streaming: boolean
}

/** 可折叠思考块:收起一行「思考过程 ▸」,展开显示全文(弱化色、小一号字、左侧竖线缩进)。 */
export function ThinkingBlock({ thinking, streaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(streaming)
  // 流式开始展开、结束折叠;手动点开/收起后,以下一次流式状态变化为准。
  useEffect(() => {
    setExpanded(streaming)
  }, [streaming])

  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        思考过程 {expanded ? '▾' : '▸'}
      </button>
      {expanded && <div className="thinking-body">{thinking}</div>}
    </div>
  )
}
