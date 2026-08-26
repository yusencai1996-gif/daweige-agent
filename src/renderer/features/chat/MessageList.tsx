import { useLayoutEffect, useMemo, useRef } from 'react'
import { MarkdownMessage } from '../../components/MarkdownMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolStatus } from './ToolStatus'
import { DelegationCard, type DelegationCardActions } from '../manager/DelegationCard'
import {
  GuardrailsDraftCard,
  type GuardrailsDraftCardActions,
} from '../manager/GuardrailsDraftCard'
import {
  extractRoleDrafts,
  type RoleDraftExtraction,
} from '../manager/role-draft-parser'
import type { ConversationTimelineItem } from '../manager/conversation-timeline'

interface MessageListProps {
  /** 合并后的时间线(PLAN §10.2):消息与派活卡按 createdAt 排好序,由 ChatView 用 mergeTimeline 构造。 */
  readonly items: readonly ConversationTimelineItem[]
  /** AI 消息气泡上的名字(A-13):当前会话所属角色的 displayName,由 ChatView 会话级透传。 */
  readonly roleName: string
  /** 正在流式输出的 assistant 消息 id;思考块流式中默认展开、结束后自动折叠。 */
  readonly streamingMessageId: string | null
  readonly onRetry: () => void
  /** 派活卡动作合集;普通会话时间线里没有 run 项,用不到它。 */
  readonly delegation: DelegationCardActions
  /**
   * 守则草稿卡动作(批 2b,PLAN §10.5):给了才解析 daweige-role-draft 块;
   * 没给(internal 只读详情页)时草稿块原样按 markdown 代码块显示。
   */
  readonly draftActions?: GuardrailsDraftCardActions
}

/** 消息流;用户没往上翻时自动滚到底。确认卡片已挪到输入区上方浮层(ChatView)。 */
export function MessageList({ items, roleName, streamingMessageId, onRetry, delegation, draftActions }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottomRef = useRef(true)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  /**
   * 守则草稿块提取(批 2b):有效块从正文剔除、由卡片呈现;坏块一个字符不动,
   * 原样按普通 markdown 渲染(AI 绝不直接落守则文件)。流式半截未闭合栅栏
   * 不匹配提取,自然留在正文里,等闭合后再成卡。
   */
  const draftExtractions = useMemo(() => {
    if (draftActions === undefined) return null
    const map = new Map<string, RoleDraftExtraction>()
    for (const item of items) {
      if (item.kind !== 'message' || item.message.role !== 'assistant') continue
      const extraction = extractRoleDrafts(item.message.text)
      if (extraction.drafts.length > 0) map.set(item.message.id, extraction)
    }
    return map
  }, [items, draftActions])

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
        {items.map((item) => {
          // 派活卡(0.3.0):渲染层合并进时间线,不伪装成 ChatMessage 落库
          if (item.kind === 'run') {
            return <DelegationCard key={`run-${item.run.runId}`} run={item.run} actions={delegation} />
          }
          const message = item.message
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
          // 守则草稿(批 2b):有效块剔出正文成卡;正文掏空后不再渲染空 markdown 容器
          const extraction = draftExtractions?.get(message.id)
          const text = extraction?.text ?? message.text
          return (
            <div key={message.id} className="msg-assistant">
              <div className="msg-role">{roleName}</div>
              {hasThinking && (
                <ThinkingBlock thinking={message.thinking ?? ''} streaming={isStreaming} />
              )}
              {text === '' ? (
                // 只有流式中的消息才显示"正在想…";历史空文本消息(纯工具调用)不显示占位
                isStreaming && <div className="msg-thinking">正在想…</div>
              ) : (
                <div className="msg-text">
                  <MarkdownMessage text={text} />
                </div>
              )}
              {extraction !== undefined &&
                draftActions !== undefined &&
                extraction.drafts.map((draft, index) => (
                  <GuardrailsDraftCard
                    key={`${message.id}-draft-${index}`}
                    draft={draft}
                    actions={draftActions}
                  />
                ))}
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
