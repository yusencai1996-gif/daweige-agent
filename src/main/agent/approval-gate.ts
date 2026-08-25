import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { ApprovalKind } from '../../shared/domain/approval'
import type { PathPolicy } from '../files/path-policy'
import type { ApprovalBroker } from './approval-broker'

/**
 * 确认闸门(M4-02 集成):Agent 的 beforeToolCall 钩子。
 * - 读类工具:工作区内放行;工作区外弹确认(kind=outside-read);应用内部拒绝
 * - 记忆工具:放行(save_memory 写应用内部数据免确认,PLAN 明确)
 * - 写类工具:全部弹确认(工作区内也确认);应用内部拒绝;任何越界目标在卡片上标明
 * - 拒绝附言非空 → 作为 block reason 回传模型,下一轮可引用调整
 */

const READ_TOOLS = new Set(['read_file', 'list_directory', 'read_docx', 'read_workbook'])
const MEMORY_TOOLS = new Set(['save_memory', 'search_memories'])
/** 守则工具(0.2.0):永远逐次弹卡,不吃任何会话级授权(红线,PLAN §3.3)。 */
const ROLE_RULES_TOOLS = new Set(['edit_role_guardrails'])
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_docx',
  'write_workbook',
  'move_paths',
  'rename_path',
  'delete_paths',
  'make_directory',
])

const KIND_BY_TOOL: Record<string, ApprovalKind> = {
  write_file: 'write',
  write_docx: 'write',
  write_workbook: 'write',
  edit_file: 'edit',
  move_paths: 'move',
  rename_path: 'rename',
  delete_paths: 'delete',
  make_directory: 'mkdir',
}

/** 统一拒绝话术(用户没留附言时用)。 */
export const DEFAULT_REJECT_REASON = '用户没有批准这次操作。请调整方案(比如只动部分文件、换目标位置),或先向用户解释清楚再试。'

export interface ApprovalGateDeps {
  broker: ApprovalBroker
  sessionId: string
  policy: PathPolicy
  /** 当前会话所属角色的显示名(守则确认卡用;查不到时卡片退化为"当前角色")。 */
  getRoleDisplayName?: () => Promise<string | undefined>
}

export function createApprovalGate(deps: ApprovalGateDeps) {
  return async (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const name = context.toolCall.name
    const args = (argsOf(context) ?? {}) as Record<string, unknown>

      if (MEMORY_TOOLS.has(name)) return undefined

      if (ROLE_RULES_TOOLS.has(name)) {
        // 改守则必须用户点头:每次调用都弹卡,用户拒绝/超时即不落盘。
        // 不查会话授权(gate 消费侧硬排除),broker 登记侧同样排除——双保险。
        const oldStr = typeof args['old_string'] === 'string' ? (args['old_string'] as string) : ''
        const newStr = typeof args['new_string'] === 'string' ? (args['new_string'] as string) : ''
        const roleName = (await deps.getRoleDisplayName?.()) ?? '当前角色'
        const outcome = await deps.broker.request({
          sessionId: deps.sessionId,
          kind: 'role-rules-edit',
          toolCallId: context.toolCall.id,
          toolName: name,
          title: `我要修改「${roleName}」的守则`,
          description: `把「${snip(oldStr)}」改为「${snip(newStr)}」。守则是你为这个角色定的规矩,改了会一直生效;批准后从下一条消息开始用新守则。`,
          itemCount: 1,
          samplePaths: [],
          recoverable: false,
          outsideWorkspace: false,
        })
        return settle(outcome)
      }

    if (READ_TOOLS.has(name)) {
      const path = pickPath(args)
      if (!path) return undefined // 参数异常交给 schema 校验
      const { zone } = await deps.policy.classify(path)
      if (zone === 'app-internal') {
        return { block: true, reason: '应用内部数据不允许读取。' }
      }
      if (zone === 'workspace') return undefined
      const outcome = await deps.broker.request({
        sessionId: deps.sessionId,
        kind: 'outside-read',
        toolCallId: context.toolCall.id,
        title: '我要读取工作文件夹外的文件',
        description: `读取:${path}(在选定的工作文件夹之外,需要你点头)`,
        itemCount: 1,
        samplePaths: [path],
        recoverable: true,
        outsideWorkspace: true,
      })
      return settle(outcome)
    }

    if (WRITE_TOOLS.has(name)) {
      const affected = pickAffectedPaths(name, args)
      const destination = typeof args['destination_dir'] === 'string' ? (args['destination_dir'] as string) : undefined
      const checkPaths = destination !== undefined ? [...affected, destination] : affected
      const invalid = firstInvalidWriteTarget(checkPaths, deps.policy)
      if (invalid) {
        return { block: true, reason: `这次操作没法执行:${invalid}` }
      }
      // 批量写:预检全部目标区域(受影响项 + 目标目录)
      const zones = await Promise.all(checkPaths.map((p) => deps.policy.classify(p)))
      if (zones.some((z) => z.zone === 'app-internal')) {
        return { block: true, reason: '应用内部数据不允许修改。' }
      }
      const outside = zones.some((z) => z.zone === 'outside')
      // 会话级授权(A-01):用户点过"本次会话全部允许"的工具,工作区内免再弹卡;
      // 删除与工作区外操作永远逐次确认(安全底线)。
      if (!outside && name !== 'delete_paths' && deps.broker.hasSessionGrant(deps.sessionId, name)) {
        return undefined
      }
      const summary = buildSummary(name, args, affected.length, outside)
      const outcome = await deps.broker.request({
        sessionId: deps.sessionId,
        kind: KIND_BY_TOOL[name] ?? 'write',
        toolCallId: context.toolCall.id,
        toolName: name,
        title: summary.title,
        description: summary.description,
        itemCount: affected.length,
        samplePaths: affected,
        recoverable: name === 'delete_paths', // 删除走回收站
        outsideWorkspace: outside,
      })
      return settle(outcome)
    }

    // 未分类工具(不应发生):保守拒绝
    return { block: true, reason: `工具 ${name} 未登记,已阻止。` }
  }
}

function settle(
  outcome: Awaited<ReturnType<ApprovalBroker['request']>>,
): BeforeToolCallResult | undefined {
  if (outcome.decision === 'approve') return undefined
  if (outcome.note && outcome.note.length > 0) {
    return { block: true, reason: `用户拒绝了这次操作,并说:${outcome.note}` }
  }
  return { block: true, reason: DEFAULT_REJECT_REASON }
}

function argsOf(context: BeforeToolCallContext): unknown {
  return context.args
}

/** 读取类:单 path 参数。 */
function pickPath(args: Record<string, unknown>): string | undefined {
  const p = args['path']
  return typeof p === 'string' ? p : undefined
}

/** 写类:收集受影响的路径(不含 move 的目标目录,目标单独检查)。 */
function pickAffectedPaths(name: string, args: Record<string, unknown>): string[] {
  const paths: string[] = []
  if (typeof args['path'] === 'string') paths.push(args['path'])
  const list = args['paths']
  if (Array.isArray(list)) {
    for (const p of list) if (typeof p === 'string') paths.push(p)
  }
  if (name === 'rename_path' && typeof args['new_name'] === 'string' && typeof args['path'] === 'string') {
    paths.push(joinName(args['path'] as string, args['new_name']))
  }
  return paths
}

function joinName(path: string, newName: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return idx === -1 ? newName : path.slice(0, idx + 1) + newName
}

function firstInvalidWriteTarget(paths: string[], policy: PathPolicy): string | undefined {
  for (const p of paths) {
    try {
      policy.assertWritable(p)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  return undefined
}

/** 确认卡的人话文案(M4-04:直接说明做什么、改什么内容、影响多少、是否可恢复)。 */
export function buildSummary(
  toolName: string,
  args: Record<string, unknown>,
  count: number,
  outside: boolean,
): { title: string; description: string } {
  const first = typeof args['path'] === 'string' ? (args['path'] as string) : undefined
  const dest = typeof args['destination_dir'] === 'string' ? (args['destination_dir'] as string) : ''
  const outsideNote = outside ? '注意:有目标在选定的工作文件夹之外。' : ''
  switch (toolName) {
    case 'write_file': {
      const content = typeof args['content'] === 'string' ? (args['content'] as string) : ''
      const preview = content.replace(/\s+/g, ' ').slice(0, 40)
      return {
        title: '我要写入 1 个文件',
        description: `写入:${first ?? '(未提供路径)'}。如果文件已存在,原内容会被替换。${contentPreview(content, preview)}${outsideNote}`,
      }
    }
    case 'write_docx': {
      const title = typeof args['title'] === 'string' ? (args['title'] as string) : ''
      const sections = Array.isArray(args['sections']) ? args['sections'].length : 0
      return {
        title: '我要生成 1 个 Word 文档',
        description: `保存到:${first ?? ''}。文档标题「${title}」,约 ${sections} 个小节。${outsideNote}`,
      }
    }
    case 'write_workbook': {
      const sheets = Array.isArray(args['sheets']) ? args['sheets'] : []
      const firstSheet = sheets[0] as { name?: string; rows?: unknown[] } | undefined
      const rowsNote = firstSheet?.rows ? `首个工作表「${firstSheet.name}」约 ${firstSheet.rows.length} 行` : ''
      return {
        title: '我要生成 1 个表格文件',
        description: `保存到:${first ?? ''}。共 ${sheets.length} 个工作表${rowsNote ? `,${rowsNote}` : ''}。如果文件已存在,原内容会被替换。${outsideNote}`,
      }
    }
    case 'edit_file': {
      const oldStr = typeof args['old_string'] === 'string' ? (args['old_string'] as string) : ''
      const newStr = typeof args['new_string'] === 'string' ? (args['new_string'] as string) : ''
      return {
        title: '我要修改 1 个文件的一小部分',
        description: `修改:${first ?? ''}。把「${snip(oldStr)}」改为「${snip(newStr)}」,其余内容不动。${outsideNote}`,
      }
    }
    case 'move_paths':
      return {
        title: `我要移动 ${count} 个项目`,
        description: `移到:${dest}。文件本身不变,只是换位置。${outsideNote}`,
      }
    case 'rename_path':
      return {
        title: '我要给 1 个文件改名字',
        description: `${first ?? ''} 改名为「${typeof args['new_name'] === 'string' ? args['new_name'] : ''}」。${outsideNote}`,
      }
    case 'delete_paths':
      return {
        title: `我要删除 ${Math.max(count, 1)} 个项目`,
        description: '删除会放进回收站,误删了还能找回来。',
      }
    case 'make_directory':
      return { title: '我要新建 1 个文件夹', description: `位置:${first ?? ''}。${outsideNote}` }
    default:
      return { title: '我要执行一次文件操作', description: outsideNote || '请确认是否允许。' }
  }
}

function contentPreview(content: string, preview: string): string {
  if (content.length === 0) return ''
  const size = content.length < 1000 ? `${content.length} 字` : `约 ${Math.round(content.length / 1000)} 千字`
  return `内容开头是:「${preview}…」(共 ${size})。`
}

function snip(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 30)
}
