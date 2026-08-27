import { describe, expect, it } from 'vitest'
import type { Entry } from '@earendil-works/pi-agent-core'
import { entriesToChatMessages } from '../../../src/main/agent/message-mapper'
import type { CommandResultDetails } from '../../../src/shared/domain/command'

let entrySeq = 0

/** 构造 pi message entry(形状对齐 Session entry;mapper 只读这几个字段)。 */
function messageEntry(message: Record<string, unknown>): Entry {
  entrySeq += 1
  return { type: 'message', id: `e${entrySeq}`, timestamp: entrySeq, message } as unknown as Entry
}

const sampleDetails: CommandResultDetails = {
  command: 'cmd /c "dir /b D:\\门店报表"',
  cwd: 'D:\\门店报表',
  exitCode: 0,
  durationMs: 420,
  timedOut: false,
  cancelled: false,
  stdout: '2026-06报表.xlsx\n2026-07报表.xlsx',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
}

describe('message-mapper:run_command 终值恢复(0.4.0 C)', () => {
  it('toolResult.details → assistant 工具行带 command 终值,CommandBlock 刷新可重建', () => {
    const messages = entriesToChatMessages([
      messageEntry({ role: 'user', content: [{ type: 'text', text: '看看报表' }] }),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'run_command', arguments: {} }],
      }),
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'run_command',
        content: [{ type: 'text', text: '命令完成,退出码 0' }],
        details: sampleDetails,
        isError: false,
      }),
    ])
    expect(messages).toHaveLength(2)
    const assistant = messages[1]
    expect(assistant?.kind === 'chat' && assistant.role === 'assistant').toBe(true)
    const exec =
      assistant?.kind === 'chat' && assistant.role === 'assistant'
        ? assistant.toolExecutions?.[0]
        : undefined
    expect(exec?.toolName).toBe('run_command')
    expect(exec?.status).toBe('succeeded')
    expect(exec?.command).toEqual(sampleDetails)
  })

  it('坏 details(缺字段/类型错)丢弃不崩,降级为普通工具行', () => {
    const bad: unknown[] = [
      null,
      'string-not-object',
      { command: 123, cwd: 'D:\\', exitCode: 0, durationMs: 1, timedOut: false, cancelled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false },
      { ...sampleDetails, exitCode: 'zero' },
      { ...sampleDetails, stdout: undefined },
    ]
    for (const details of bad) {
      const messages = entriesToChatMessages([
        messageEntry({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc-1', name: 'run_command', arguments: {} }],
        }),
        messageEntry({
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'run_command',
          content: [{ type: 'text', text: 'ok' }],
          details,
          isError: false,
        }),
      ])
      const first = messages[0]
      const exec =
        first?.kind === 'chat' && first.role === 'assistant' ? first.toolExecutions?.[0] : undefined
      expect(exec?.command).toBeUndefined()
      expect(exec?.status).toBe('succeeded')
    }
  })

  it('非 run_command 工具的 details 不进 command 字段(普通工具不受影响)', () => {
    const messages = entriesToChatMessages([
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-9', name: 'list_directory', arguments: {} }],
      }),
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-9',
        toolName: 'list_directory',
        content: [{ type: 'text', text: 'a.txt' }],
        details: sampleDetails,
        isError: false,
      }),
    ])
    const first = messages[0]
    const exec = first?.kind === 'chat' && first.role === 'assistant' ? first.toolExecutions?.[0] : undefined
    expect(exec?.toolName).toBe('list_directory')
    expect(exec?.command).toBeUndefined()
  })

  it('命令失败(isError)的 run_command:状态真实化 + details 仍恢复(过程可回看)', () => {
    const messages = entriesToChatMessages([
      messageEntry({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc-2', name: 'run_command', arguments: {} }],
      }),
      messageEntry({
        role: 'toolResult',
        toolCallId: 'tc-2',
        toolName: 'run_command',
        content: [{ type: 'text', text: '命令失败,退出码 2。' }],
        details: { ...sampleDetails, exitCode: 2, stderr: 'boom' },
        isError: true,
      }),
    ])
    const first = messages[0]
    const exec = first?.kind === 'chat' && first.role === 'assistant' ? first.toolExecutions?.[0] : undefined
    expect(exec?.status).toBe('failed')
    expect(exec?.command?.exitCode).toBe(2)
    expect(exec?.command?.stderr).toBe('boom')
  })
})
