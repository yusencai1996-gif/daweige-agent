import { describe, expect, it } from 'vitest'
import {
  attachCommandDetails,
  capChunks,
  joinChunks,
} from '../../../src/renderer/app/use-app-controller'
import type { ChatMessage } from '../../../src/shared/domain'
import type { CommandResultDetails } from '../../../src/shared/domain/command'

function assistantWithTools(toolCallIds: readonly string[]): ChatMessage {
  return {
    kind: 'chat',
    role: 'assistant',
    id: 'm1',
    text: '我跑了条命令',
    createdAt: 1,
    toolExecutions: toolCallIds.map((id) => ({
      toolCallId: id,
      toolName: 'run_command',
      displayName: '运行命令',
      status: 'running' as const,
      summary: 'cmd /c dir',
    })),
  }
}

describe('命令实时输出纯函数(0.4.0 C 收尾)', () => {
  it('joinChunks:按 sequence 排序拼接,乱序到达不乱文', () => {
    const chunks = new Map<number, string>([
      [2, '世界'],
      [0, '你'],
      [1, '好'],
    ])
    expect(joinChunks(chunks)).toBe('你好世界')
  })

  it('joinChunks:重复 sequence 以后到者为准(Map 语义),不重复拼接', () => {
    const chunks = new Map<number, string>([
      [0, 'a'],
      [1, 'b'],
    ])
    chunks.set(1, 'B')
    expect(joinChunks(chunks)).toBe('aB')
  })

  it('capChunks:超 256 KiB 丢最旧段保尾部,标 dropped', () => {
    const chunks = new Map<number, string>()
    chunks.set(0, 'x'.repeat(200 * 1024))
    chunks.set(1, 'y'.repeat(100 * 1024)) // 总 300KiB > 256KiB
    const { chunks: capped, dropped } = capChunks(chunks)
    expect(dropped).toBe(true)
    expect(capped.has(0)).toBe(false)
    expect(capped.has(1)).toBe(true)
    let total = 0
    for (const t of capped.values()) total += t.length
    expect(total).toBeLessThanOrEqual(256 * 1024)
  })

  it('capChunks:未超限原样返回不丢', () => {
    const chunks = new Map<number, string>([[0, 'abc']])
    const { chunks: capped, dropped } = capChunks(chunks)
    expect(dropped).toBe(false)
    expect(capped).toBe(chunks)
  })

  it('attachCommandDetails:终值挂进对应工具行,其他消息不动', () => {
    const details: CommandResultDetails = {
      command: 'cmd /c dir',
      cwd: 'D:\\demo',
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      cancelled: false,
      stdout: 'a.txt',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }
    const messages: readonly ChatMessage[] = [
      { kind: 'chat', role: 'user', id: 'm0', text: '跑一下', createdAt: 0 },
      assistantWithTools(['tc-1', 'tc-2']),
    ]
    const next = attachCommandDetails(messages, 'tc-2', details)
    const assistant = next[1]
    if (assistant?.kind !== 'chat' || assistant.role !== 'assistant') throw new Error('不达')
    expect(assistant.toolExecutions?.[0]?.command).toBeUndefined()
    expect(assistant.toolExecutions?.[1]?.command).toEqual(details)
    // 原 messages 不可变,不被原地修改
    const original = messages[1]
    if (original?.kind !== 'chat' || original.role !== 'assistant') throw new Error('不达')
    expect(original.toolExecutions?.[1]?.command).toBeUndefined()
  })

  it('attachCommandDetails:找不到对应工具行(切走会话)无命中无害', () => {
    const messages: readonly ChatMessage[] = [assistantWithTools(['tc-other'])]
    const details = {} as CommandResultDetails
    const next = attachCommandDetails(messages, 'tc-none', details)
    const first = next[0]
    const exec = first?.kind === 'chat' && first.role === 'assistant' ? first.toolExecutions?.[0] : undefined
    expect(exec?.command).toBeUndefined()
    expect(exec?.toolCallId).toBe('tc-other')
  })
})
