// A-29:压缩提示行——收起态只露低调一行、不泄露摘要;展开态摘要全文可见可收起。
// 另验 MessageList 集成路径:kind='compaction' 消息在时间线里渲染成提示行。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CompactionNoticeLine } from '../../../src/renderer/features/chat/CompactionNotice'
import { MessageList } from '../../../src/renderer/features/chat/MessageList'
import type { DelegationCardActions } from '../../../src/renderer/features/manager/DelegationCard'
import type { CompactionNoticeMessage } from '../../../src/shared/domain'

const notice: CompactionNoticeMessage = {
  kind: 'compaction',
  role: 'system',
  id: 'compact-1',
  summary: '摘要全文:下载文件夹共 38 张图片,按月份归档。',
  tokensBefore: 182_400,
  tokensAfter: 3_120,
  createdAt: 1_000,
}

/** MessageList 集成测试用的派活动作空壳(本用例时间线里没有 run 卡,不会真调到)。 */
const delegationStub: DelegationCardActions = {
  approvalFor: () => undefined,
  detailFor: () => undefined,
  detailLoadingFor: () => false,
  onLoadDetail: () => undefined,
  onOpenFullDetail: () => undefined,
  onRespond: () => undefined,
  chainPeersFor: () => [],
  interruptBusyFor: () => false,
  onInterrupt: () => undefined,
}

describe('CompactionNoticeLine', () => {
  it('收起态:只有一行提示与「查看摘要」,不渲染摘要全文', () => {
    const html = renderToStaticMarkup(
      createElement(CompactionNoticeLine, { message: notice, expanded: false, onToggle: () => {} }),
    )
    expect(html).toContain('已将较早对话压缩为摘要')
    expect(html).toContain('查看摘要')
    expect(html).not.toContain('摘要全文')
    expect(html).toContain('aria-expanded="false"')
  })

  it('展开态:摘要全文可见,按钮变「收起」', () => {
    const html = renderToStaticMarkup(
      createElement(CompactionNoticeLine, { message: notice, expanded: true, onToggle: () => {} }),
    )
    expect(html).toContain('摘要全文:下载文件夹共 38 张图片,按月份归档。')
    expect(html).toContain('收起')
    expect(html).toContain('aria-expanded="true"')
  })

  it('title 带 token 变化(压缩前/后),不占正文', () => {
    const html = renderToStaticMarkup(
      createElement(CompactionNoticeLine, { message: notice, expanded: false, onToggle: () => {} }),
    )
    expect(html).toContain('182400')
    expect(html).toContain('3120')
  })
})

describe('MessageList 渲染 compaction 消息', () => {
  it('kind=compaction 的消息渲染为低调提示行,不当普通气泡', () => {
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        items: [
          {
            kind: 'message' as const,
            message: {
              kind: 'chat' as const,
              role: 'user' as const,
              id: 'u1',
              text: '先聊一句',
              createdAt: 900,
            },
          },
          { kind: 'message' as const, message: notice },
        ],
        roleName: '小编',
        streamingMessageId: null,
        onRetry: () => {},
        delegation: delegationStub,
      }),
    )
    expect(html).toContain('msg-compaction')
    expect(html).toContain('已将较早对话压缩为摘要')
    // 默认收起:摘要不外露
    expect(html).not.toContain('摘要全文')
  })
})
