import { useState } from 'react'
import type { CompactionNoticeMessage } from '../../../shared/domain'

interface CompactionNoticeLineProps {
  readonly message: CompactionNoticeMessage
  readonly expanded: boolean
  readonly onToggle: () => void
}

/**
 * 压缩提示行(纯展示层,便于静态渲染测试):
 * 消息流里低调一行「已将较早对话压缩为摘要」,点击展开摘要全文,再点收起。
 * 墨色小字,不弹不闹;token 变化只放 title,不抢正文。
 */
export function CompactionNoticeLine({ message, expanded, onToggle }: CompactionNoticeLineProps) {
  return (
    <div className="msg-compaction">
      <button
        type="button"
        className="msg-compaction-toggle"
        aria-expanded={expanded}
        title={`压缩前约 ${message.tokensBefore} tokens,压缩后约 ${message.tokensAfter} tokens`}
        onClick={onToggle}
      >
        <span className="msg-compaction-dot" aria-hidden="true" />
        <span>已将较早对话压缩为摘要</span>
        <span className="msg-compaction-more">{expanded ? '收起' : '查看摘要'}</span>
      </button>
      {expanded && <div className="msg-compaction-summary">{message.summary}</div>}
    </div>
  )
}

/** 压缩提示行(A-29):展开/收起状态只记在组件本地,不持久化。 */
export function CompactionNotice({ message }: { readonly message: CompactionNoticeMessage }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <CompactionNoticeLine
      message={message}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    />
  )
}
