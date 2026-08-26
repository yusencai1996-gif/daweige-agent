/**
 * manager 消息时间线(PLAN §10.2,0.3.0 批 2a):
 * 把 pi 消息(ChatMessage)与派活卡(AgentRunSummary)按 createdAt 稳定合并成一条流。
 * 同毫秒顺序:user → assistant/其他消息 → run 卡。
 * 铁律:run 卡只在渲染层合并,不伪装成 ChatMessage 落库。
 */
import type { AgentRunSummary, ChatMessage } from '../../../shared/domain'

export type ConversationTimelineItem =
  | { readonly kind: 'message'; readonly message: ChatMessage }
  | { readonly kind: 'run'; readonly run: AgentRunSummary }

function sortAt(item: ConversationTimelineItem): number {
  return item.kind === 'run' ? item.run.createdAt : item.message.createdAt
}

/** 同毫秒时的先后:用户消息 0,assistant/error 1,派活卡 2。 */
function sameMsRank(item: ConversationTimelineItem): number {
  if (item.kind === 'run') return 2
  return item.message.role === 'user' ? 0 : 1
}

export function mergeTimeline(
  messages: readonly ChatMessage[],
  runs: readonly AgentRunSummary[],
): ConversationTimelineItem[] {
  const items: ConversationTimelineItem[] = [
    ...messages.map((message) => ({ kind: 'message' as const, message })),
    ...runs.map((run) => ({ kind: 'run' as const, run })),
  ]
  // 带上原下标做最后兜底,保证结果稳定(数组顺序即输入顺序)
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        sortAt(a.item) - sortAt(b.item) || sameMsRank(a.item) - sameMsRank(b.item) || a.index - b.index,
    )
    .map(({ item }) => item)
}
