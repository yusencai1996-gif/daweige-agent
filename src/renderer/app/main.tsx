import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatMessage, MemoryEntry, SessionDetail, SessionSummary } from '../../shared/domain'
import type { DaweigeBridge } from '../../shared/ipc/bridge'
import type { MockBridge } from '../../../tests/helpers/mock-bridge'
import { App } from './App'
import '../styles/global.css'
import '../styles/sidebar.css'
import '../styles/chat.css'
import '../styles/markdown.css'
import '../styles/approvals.css'
import '../styles/settings.css'
import '../styles/reminders.css'
import '../features/roles/roles.css'
import '../features/usage/usage.css'

/**
 * 渲染进程入口。
 * 桥装配优先级:真实 preload 桥(Electron dev/生产)→ MockBridge(纯 web 预览,无 Electron 环境)。
 */
async function createBridge(): Promise<DaweigeBridge> {
  // Electron 环境(dev 与生产构建)都有 preload 暴露的真桥
  const real = window.daweige
  if (real) return real

  // 纯 web 预览(vite.renderer.config.ts,无 Electron):用 MockBridge
  if (import.meta.env.DEV) {
    const { MockBridge } = await import('../../../tests/helpers/mock-bridge')
    const mock = new MockBridge()
    wireDemoBehaviors(mock)
    window.__daweigeMock = mock
    return mock
  }
  throw new Error('窗口数据通道不可用,请重新启动应用')
}

/* ================= 以下为 DEV 演示行为(只活在开发态) ================= */

const DEMO_REPLY = `好的,我看了一下,这活儿可以这么干:

## 我的计划

1. 先扫一遍文件夹,把图片都挑出来
2. 按拍摄月份建好文件夹
3. 移动之前,把清单给你过目

| 类型 | 数量 |
| --- | --- |
| 图片 | 38 张 |
| 文档 | 12 个 |
| 其他 | 5 个 |

只是挪文件,一条命令都不用跑:

\`\`\`text
IMG_2031.jpg  →  2026-07/
IMG_2032.jpg  →  2026-07/
\`\`\`

确认一下我就动手。更多用法可以以后慢慢聊,先看[这个说明](https://example.com/daweige)也行。`

/** 把回复切成若干增量,模拟 text_delta 流。 */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

function wireDemoBehaviors(mock: MockBridge): void {
  const now = Date.now()
  let idCounter = 0
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`

  const demoSummary: SessionSummary = {
    id: 'demo-session-1',
    title: '整理下载文件夹',
    workspacePath: 'C:\\Users\\demo\\Downloads',
    roleId: 'agent-a1b2c3d4e5f6',
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 3_600_000,
    updatedAt: now - 1_800_000,
    messageCount: 2,
  }
  const demoHistory: ChatMessage[] = [
    {
      kind: 'chat',
      role: 'user',
      id: 'demo-msg-u1',
      text: '帮我把下载文件夹里的图片整理一下',
      createdAt: now - 3_000_000,
    },
    {
      kind: 'chat',
      role: 'assistant',
      id: 'demo-msg-a1',
      text: '好的。我数了一下,里面一共有 **38 张图片**。\n\n如果你想,我可以按月份给它们建好文件夹再移过去——你说一声就行。',
      createdAt: now - 2_990_000,
    },
  ]

  const summaries: SessionSummary[] = [demoSummary]
  const archivedSummary: SessionSummary = {
    id: 'demo-session-2',
    title: '去年的旧稿',
    workspacePath: 'C:\\Users\\demo\\Documents\\稿件',
    roleId: 'agent-a1b2c3d4e5f6',
    archivedAt: now - 86_400_000,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 8 * 86_400_000,
    updatedAt: now - 2 * 86_400_000,
    messageCount: 12,
  }
  const legacySummary: SessionSummary = {
    id: 'demo-session-legacy',
    title: '找不到文件夹前的旧对话',
    workspacePath: '',
    roleId: 'agent-e5f6a7b8c9d0',
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 40 * 86_400_000,
    updatedAt: now - 20 * 86_400_000,
    messageCount: 1,
  }
  summaries.push(archivedSummary, legacySummary)
  const details = new Map<string, SessionDetail>([
    ['demo-session-1', { summary: demoSummary, messages: demoHistory }],
    [
      'demo-session-legacy',
      {
        summary: legacySummary,
        messages: [
          {
            kind: 'chat',
            role: 'user',
            id: 'demo-legacy-u1',
            text: '(旧对话)那时候的工作文件夹已经不在了',
            createdAt: now - 40 * 86_400_000,
          },
        ],
      },
    ],
  ])
  const timers = new Map<string, number[]>()
  const pendingApprovals = new Map<
    string,
    { sessionId: string; toolCallId: string; messageId: string }
  >()

  const schedule = (sessionId: string, fn: () => void, delay: number) => {
    const timer = window.setTimeout(fn, delay)
    const list = timers.get(sessionId) ?? []
    list.push(timer)
    timers.set(sessionId, list)
  }
  const clearTimers = (sessionId: string) => {
    for (const timer of timers.get(sessionId) ?? []) window.clearTimeout(timer)
    timers.set(sessionId, [])
  }

  mock.seedDemoState({ sessions: [...summaries] })

  // 使用统计演示数据:dev 预览直接可开「使用统计」整页
  mock.handle('usage:getDashboard', async () => {
    const { demoUsageDashboard } = await import('../../../tests/helpers/mock-bridge')
    return demoUsageDashboard()
  })

  mock.handle('session:list', () => summaries)
  mock.handle('session:open', ({ sessionId }) => {
    const detail = details.get(sessionId)
    if (!detail) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    return detail
  })
  mock.handle('session:create', ({ roleId, providerId, modelId }) => {
    const createdAt = Date.now()
    const summary: SessionSummary = {
      id: nextId('session'),
      title: '新会话',
      workspacePath: 'C:\\Users\\demo\\Downloads',
      roleId,
      archivedAt: null,
      providerId,
      modelId,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
    }
    const detail: SessionDetail = { summary, messages: [] }
    summaries.unshift(summary)
    details.set(summary.id, detail)
    return detail
  })
  mock.handle('session:rename', ({ sessionId, title }) => {
    const index = summaries.findIndex((s) => s.id === sessionId)
    const found = index >= 0 ? summaries[index] : undefined
    if (!found) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    const renamed: SessionSummary = { ...found, title, updatedAt: Date.now() }
    summaries[index] = renamed
    const detail = details.get(sessionId)
    if (detail) details.set(sessionId, { ...detail, summary: renamed })
    return renamed
  })
  mock.handle('session:delete', ({ sessionId }) => {
    const index = summaries.findIndex((s) => s.id === sessionId)
    if (index >= 0) summaries.splice(index, 1)
    details.delete(sessionId)
    clearTimers(sessionId)
    return undefined
  })

  mock.handle('credential:save', ({ providerId, apiKey }) => {
    const tail = apiKey.slice(-4)
    return {
      providerId,
      configured: true as const,
      maskedKey: `sk-****${tail === '' ? 'demo' : tail}`,
    }
  })
  mock.handle('credential:test', () => ({
    ok: true,
    message: '连接正常,当前模型 kimi-for-coding',
  }))

  // 记忆管理演示数据:dev 预览走同一座桥,可真实演练查看/删除
  const demoMemories: MemoryEntry[] = [
    {
      id: 'demo-mem-1',
      text: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
      createdAt: now - 86_400_000,
    },
    {
      id: 'demo-mem-2',
      text: '和老婆结婚纪念日是 2020 年 10 月 1 日',
      title: '结婚纪念日',
      category: '纪念日',
      date: { kind: 'recurring', month: 10, day: 1 },
      createdAt: now - 2 * 86_400_000,
    },
    {
      id: 'demo-mem-3',
      text: '2026-09-01 车子要年检',
      title: '车子年检',
      category: '待办',
      date: { kind: 'fixed', iso: '2026-09-01' },
      createdAt: now - 3 * 86_400_000,
    },
    {
      id: 'demo-mem-4',
      text: '我喜欢喝淡一点的茶',
      title: '喝茶偏好',
      category: '偏好',
      createdAt: now - 4 * 86_400_000,
    },
  ]
  mock.handle('memory:list', () => demoMemories)
  mock.handle('memory:delete', ({ memoryId }) => {
    const index = demoMemories.findIndex((m) => m.id === memoryId)
    if (index < 0) return { deleted: false }
    demoMemories.splice(index, 1)
    return { deleted: true }
  })

  mock.handle('message:abort', ({ sessionId }) => {
    clearTimers(sessionId)
    mock.emitAgentEvent({ type: 'agent_end', sessionId })
    return undefined
  })

  mock.handle('approval:respond', ({ approvalId, decision }) => {
    const pending = pendingApprovals.get(approvalId)
    if (!pending) return Promise.reject(new Error('确认 ID 不存在或已经处理过了'))
    pendingApprovals.delete(approvalId)
    const { sessionId, toolCallId, messageId } = pending
    schedule(
      sessionId,
      () =>
        mock.emitAgentEvent({
          type: 'approval_resolved',
          sessionId,
          approvalId,
          decision: decision === 'reject' ? 'reject' : 'approve',
        }),
      200,
    )
    if (decision === 'approve') {
      schedule(
        sessionId,
        () =>
          mock.emitAgentEvent({
            type: 'tool_start',
            sessionId,
            messageId,
            execution: {
              toolCallId,
              toolName: 'move_files',
              displayName: '移动文件',
              status: 'running',
              summary: '移动 38 张图片到按月份建的文件夹',
            },
          }),
        500,
      )
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'tool_end', sessionId, toolCallId, status: 'succeeded' }),
        1400,
      )
    } else {
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'tool_end', sessionId, toolCallId, status: 'rejected' }),
        500,
      )
    }
    return undefined
  })

  mock.handle('message:send', ({ sessionId, text }) => {
    const detail = details.get(sessionId)
    if (!detail) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    const userMessage: ChatMessage = {
      kind: 'chat',
      role: 'user',
      id: nextId('msg-u'),
      text,
      createdAt: Date.now(),
    }
    details.set(sessionId, { ...detail, messages: [...detail.messages, userMessage] })

    const messageId = nextId('msg-a')
    const wantsApproval = /整理|移动|归档/.test(text)
    const reply = wantsApproval
      ? '数清楚了,一共 38 张图片。动手之前先问你一句:'
      : DEMO_REPLY

    schedule(
      sessionId,
      () =>
        mock.emitAgentEvent({ type: 'message_start', sessionId, messageId, createdAt: Date.now() }),
      250,
    )
    chunkText(reply, 14).forEach((delta, index) => {
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'text_delta', sessionId, messageId, delta }),
        400 + index * 90,
      )
    })
    const afterText = 400 + chunkText(reply, 14).length * 90 + 150
    if (wantsApproval) {
      const toolCallId = nextId('toolcall')
      const approvalId = nextId('approval')
      pendingApprovals.set(approvalId, { sessionId, toolCallId, messageId })
      schedule(
        sessionId,
        () =>
          mock.emitAgentEvent({
            type: 'approval_required',
            sessionId,
            request: {
              id: approvalId,
              kind: 'move',
              title: '要把这 38 张图片移到按月份建好的文件夹吗?',
              description:
                '我会在下载文件夹里建 6 个月份文件夹,把 38 张图片按拍摄月份移过去,原位置不保留副本。',
              itemCount: 38,
              samplePaths: [
                'C:\\Users\\demo\\Downloads\\IMG_2031.jpg',
                'C:\\Users\\demo\\Downloads\\IMG_2032.jpg',
                'C:\\Users\\demo\\Downloads\\截图 2026-07-01.png',
              ],
              recoverable: true,
              outsideWorkspace: false,
              toolCallId,
              createdAt: Date.now(),
            },
          }),
        afterText,
      )
    }
    schedule(
      sessionId,
      () => mock.emitAgentEvent({ type: 'message_end', sessionId, messageId }),
      afterText + 100,
    )
    schedule(
      sessionId,
      () => mock.emitAgentEvent({ type: 'agent_end', sessionId }),
      afterText + 200,
    )
    return userMessage
  })
}

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createBridge()
  .then((bridge) => {
    createRoot(container).render(
      <StrictMode>
        <App bridge={bridge} />
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    container.textContent = error instanceof Error ? error.message : String(error)
  })
