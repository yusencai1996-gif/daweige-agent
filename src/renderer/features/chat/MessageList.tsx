import { useLayoutEffect, useRef } from 'react'
import type { ChatMessage } from '../../../shared/domain'
import { MarkdownMessage } from '../../components/MarkdownMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolStatus } from './ToolStatus'

interface MessageListProps {
  readonly messages: readonly ChatMessage[]
  /** AI 消息气泡上的名字(A-13):当前会话所属角色的 displayName,由 ChatView 会话级透传。 */
  readonly roleName: string
  /** 正在流式输出的 assistant 消息 id;思考块流式中默认展开、结束后自动折叠。 */
  readonly streamingMessageId: string | null
  readonly onRetry: () => void
}

/** 消息流;用户没往上翻时自动滚到底。确认卡片已挪到输入区上方浮层(ChatView)。 */
export function MessageList({ messages, roleName, streamingMessageId, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottomRef = useRef(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  return (
    <div
      className="message-scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      }}
    >
      <div className="message-column">
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div key={message.id} className="msg-user">
                {message.text}
              </div>
            )
          }
          if (message.role === 'error') {
            return (
              <div key={message.id} className="msg-error" role="alert">
                <span className="msg-error-text">{message.text}</span>
                {message.retryable && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
                    重试
                  </button>
                )}
              </div>
            )
          }
          const isStreaming = message.id === streamingMessageId
          const hasThinking = message.thinking !== undefined && message.thinking.length > 0
          const hasTools = message.toolExecutions !== undefined && message.toolExecutions.length > 0
          return (
            <div key={message.id} className="msg-assistant">
              <div className="msg-role">{roleName}</div>
              {hasThinking && (
                <ThinkingBlock thinking={message.thinking ?? ''} streaming={isStreaming} />
              )}
              {message.text === '' ? (
                // 只有流式中的消息才显示"正在想…";历史空文本消息(纯工具调用)不显示占位
                isStreaming && <div className="msg-thinking">正在想…</div>
              ) : (
                <div className="msg-text">
                  <MarkdownMessage text={message.text} />
                </div>
              )}
              {hasTools && (
                <div className="tool-status-list">
                  {(message.toolExecutions ?? []).map((execution) => (
                    <ToolStatus key={execution.toolCallId} execution={execution} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
