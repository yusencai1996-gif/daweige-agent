import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core'
import { contentText } from '@earendil-works/pi-ai'
import type { TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import type { ChatMessage, ToolExecutionInfo } from '../../shared/domain/message'
import type { CommandResultDetails } from '../../shared/domain/command'

/**
 * 消息映射(M3-04):
 * 1. pi Entry[] → AgentMessage[](恢复 agent transcript,继续对话)
 * 2. pi Entry[] → ChatMessage[](渲染进程展示)
 */

/** 恢复 agent 对话上下文用:按序取回全部消息条目。 */
export function entriesToAgentMessages(entries: readonly Entry[]): AgentMessage[] {
  return entries.filter(isMessageEntry).map((e) => e.message)
}

type AssistantContent = readonly (TextContent | ThinkingContent | ToolCall)[]

/** 渲染展示用:映射成大微阁 ChatMessage 判别联合。 */
export function entriesToChatMessages(entries: readonly Entry[]): ChatMessage[] {
  // 先收集工具结果(按调用 id):被拒绝/失败/中断的操作不能错显示为成功(复审阻断项)
  const erroredCalls = new Map<string, string>()
  // run_command 终值详情(0.4.0 C):从 toolResult.details 恢复 CommandBlock 数据源
  const commandDetails = new Map<string, CommandResultDetails>()
  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue
    const m = entry.message
    if (m.role === 'toolResult' && m.isError) {
      erroredCalls.set(m.toolCallId, contentText(m.content))
    }
    if (m.role === 'toolResult' && m.toolName === 'run_command') {
      const details = asCommandResultDetails(m.details)
      if (details !== undefined) commandDetails.set(m.toolCallId, details)
    }
  }
  const result: ChatMessage[] = []
  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue
    const m = entry.message
    if (m.role === 'user') {
      result.push({
        kind: 'chat',
        id: entry.id,
        role: 'user',
        text: contentText(m.content),
        createdAt: entry.timestamp,
      })
    } else if (m.role === 'assistant') {
      const text = contentText(textParts(m.content))
      if (m.errorMessage !== undefined && text === '') {
        // 纯错误消息(流失败/中断):渲染为错误条;key/网络问题都可重试
        result.push({
          kind: 'error',
          id: entry.id,
          role: 'error',
          text: m.errorMessage,
          createdAt: entry.timestamp,
          retryable: true,
        })
        continue
      }
      const toolExecutions = toolCallsOf(m.content, erroredCalls, commandDetails)
      const thinking = thinkingText(m.content)
      result.push({
        kind: 'chat',
        id: entry.id,
        role: 'assistant',
        text,
        createdAt: entry.timestamp,
        ...(thinking.length > 0 ? { thinking } : {}),
        ...(toolExecutions.length > 0 ? { toolExecutions } : {}),
      })
    }
    // toolResult 消息不单独成条:工具名已在前一条 assistant 的 toolExecutions 里
  }
  return result
}

function isMessageEntry(e: Entry): e is Entry & { message: AgentMessage } {
  return e.type === 'message'
}

function textParts(content: AssistantContent): TextContent[] {
  return content.filter((p): p is TextContent => p.type === 'text')
}

/** 历史思考全文(A-02:ThinkingContent 拼接,供前端折叠块回看)。 */
function thinkingText(content: AssistantContent): string {
  return content
    .filter((p): p is ThinkingContent => p.type === 'thinking')
    .map((p) => p.thinking)
    .join('')
}

/** AssistantMessage.content 里的 ToolCall → ToolExecutionInfo(历史恢复)。
 * 状态真实化:有错误结果的调用标 rejected/failed,不再一律显示成功。 */
function toolCallsOf(
  content: AssistantContent,
  erroredCalls: ReadonlyMap<string, string>,
  commandDetails: ReadonlyMap<string, CommandResultDetails>,
): ToolExecutionInfo[] {
  return content
    .filter((p): p is ToolCall => p.type === 'toolCall')
    .map((tc) => {
      const errText = erroredCalls.get(tc.id)
      const rejected =
        errText !== undefined && (errText.includes('拒绝') || errText.includes('没有批准') || errText.includes('未执行'))
      const command = commandDetails.get(tc.id)
      return {
        toolCallId: tc.id,
        toolName: tc.name,
        displayName: TOOL_DISPLAY_NAMES[tc.name] ?? tc.name,
        ...(errText !== undefined
          ? rejected
            ? { status: 'rejected' as const }
            : { status: 'failed' as const, error: errText.slice(0, 120) }
          : { status: 'succeeded' as const }),
        ...(command !== undefined ? { command } : {}),
      }
    })
}

/** toolResult.details 形状守卫:pi 的 details 是 any,坏数据宁可丢弃也不崩渲染(fail-quiet 降级为普通工具行)。 */
function asCommandResultDetails(raw: unknown): CommandResultDetails | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (typeof d.command !== 'string' || typeof d.cwd !== 'string') return undefined
  if (typeof d.durationMs !== 'number' || !Number.isFinite(d.durationMs)) return undefined
  if (typeof d.timedOut !== 'boolean' || typeof d.cancelled !== 'boolean') return undefined
  if (d.exitCode !== null && typeof d.exitCode !== 'number') return undefined
  if (d.exitCode !== null && !Number.isFinite(d.exitCode)) return undefined
  if (typeof d.stdout !== 'string' || typeof d.stderr !== 'string') return undefined
  if (typeof d.stdoutTruncated !== 'boolean' || typeof d.stderrTruncated !== 'boolean') return undefined
  return raw as CommandResultDetails
}

/** 工具中文名(与 M4 tool-registry 的注册名保持一致)。 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: '读取文件',
  list_directory: '查看文件夹',
  write_file: '写入文件',
  edit_file: '编辑文件',
  move_paths: '移动文件',
  rename_path: '重命名',
  delete_paths: '删除文件',
  make_directory: '新建文件夹',
  read_docx: '读取 Word 文档',
  write_docx: '生成 Word 文档',
  read_workbook: '读取表格',
  write_workbook: '写入表格',
  save_memory: '记事',
  search_memories: '查记事',
}
