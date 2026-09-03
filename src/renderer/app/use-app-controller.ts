import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentRunDetail,
  AgentRunGraph,
  AgentRunSummary,
  ApprovalDecision,
  DelegationApprovalRequest,
  FileApprovalRequest,
  CommandApprovalRequest,
  SkillCandidateApprovalRequest,
  SkillInstallApprovalRequest,
  ChatMessage,
  CredentialStatus,
  ProviderId,
  ProviderSelection,
  Reminder,
  RoleDetail,
  RoleDeleteResult,
  RoleSummary,
  SessionDetail,
  SessionSummary,
  Settings,
  ThinkingLevel,
  ToolExecutionStatus,
} from '../../shared/domain'
import type { BootstrapState, ConnectivityResult, RequestOf } from '../../shared/ipc/contracts'
import type { UpdateState } from '../../shared/domain/update'
import type { CommandResultDetails } from '../../shared/domain/command'
import { joinChunks, type CommandLiveChunks } from '../features/chat/command-live'
import { isIpcErrorPayload, type IpcErrorCode } from '../../shared/ipc/errors'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { DaweigeBridge } from '../../shared/ipc/bridge'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import {
  isEnabledModel,
  resolveRoleModel,
  sameModel,
  withRoleModelDefault,
} from '../../shared/domain/model-selection'
// A-28(0.5.0 第三批):协作链常驻面板的选链/选中/合成纯函数与数据接口
import {
  composePanelGraph,
  isTerminalRunStatus,
  resolvePanelGraphId,
  resolveSelectedRunId,
  type CollabPanelActions,
  type CollabPanelData,
} from '../features/manager/collab-panel-model'
import { resolveActiveRoleName } from './active-role-name'
import { withProviderSelection } from '../features/settings/model-options'
import {
  toggleEnabledModel as toggleEnabledModelInSettings,
} from '../features/settings/model-options'
import type { DelegationCardActions } from '../features/manager/DelegationCard'

/** 确认卡片阶段:pending(等用户)→ running(执行中…)→ succeeded/rejected/failed。 */
export type ApprovalPhase = 'pending' | 'running' | 'succeeded' | 'rejected' | 'failed'

export interface ApprovalCardState {
  /** 归属会话(授权/响应按它走;切换会话再切回,等待中的卡片不丢)。 */
  readonly sessionId: string
  /** 展示会话(0.3.0,PLAN §10.4):child 的文件卡 sessionId=internal,surfaceSessionId=manager 用户会话;普通会话与 sessionId 相同。 */
  readonly surfaceSessionId: string
  /** 文件/守则/命令卡 + 技能候选/安装卡(0.7.0,kind 路由在 ChatView);delegation(0.3.0)不入此列表(由派活卡渲染)。 */
  readonly request:
    | FileApprovalRequest
    | CommandApprovalRequest
    | SkillCandidateApprovalRequest
    | SkillInstallApprovalRequest
  readonly phase: ApprovalPhase
  /** 已发过 approval:respond(重复点击只发送一次的守卫)。 */
  readonly responded: boolean
  readonly decision?: ApprovalDecision
  /** 拒绝时的附言(用于结果态回显)。 */
  readonly note?: string
  readonly error?: string
}

export type ViewMode = 'chat' | 'role-rules' | 'archive' | 'usage' | 'settings'

/** role:create 的入参(契约类型);0.2.0 UI 只提交一个文件夹。 */
export type CreateRoleInput = RequestOf<'role:create'>

/** 守则保存结果:conflict = expectedVersion 失效,已重拉最新版。 */
export type SaveGuardrailsResult = 'saved' | 'conflict' | 'error'

/** 角色删除结果:失败带回人话消息;stale = impactVersion 失效需重拉影响清单。 */
export type DeleteRoleResult =
  | { readonly ok: true; readonly result: RoleDeleteResult }
  | { readonly ok: false; readonly message: string; readonly stale: boolean }

/** 输入框右下角上下文用量环的数据(message_end 事件推送,切换会话清空)。 */
export interface ContextUsageState {
  readonly usedTokens: number
  readonly contextWindow: number
}

export interface AppController {
  readonly bootstrap: BootstrapState | null
  readonly bootstrapError: string | null
  readonly retryBootstrap: () => void
  readonly view: ViewMode
  readonly openSettings: () => void
  readonly closeSettings: () => void
  readonly openUsage: () => void
  readonly closeUsage: () => void
  readonly closeArchive: () => void
  // 会话
  readonly sessions: readonly SessionSummary[]
  readonly activeSessionId: string | null
  readonly activeDetail: SessionDetail | null
  /** 当前会话里 AI 的名字(A-13):跟会话所属角色的 displayName 走;无会话/无角色时兜底「小柊」。 */
  readonly activeRoleName: string
  readonly detailLoading: boolean
  readonly createSession: (roleId: string) => Promise<void>
  readonly openSession: (sessionId: string) => Promise<void>
  readonly renameSession: (sessionId: string, title: string) => Promise<boolean>
  readonly deleteSession: (sessionId: string) => Promise<void>
  readonly archiveSession: (sessionId: string) => Promise<void>
  readonly restoreSession: (sessionId: string) => Promise<void>
  readonly sessionBusy: boolean
  readonly notice: string | null
  // 角色(0.2.0)
  readonly roles: readonly RoleSummary[]
  /** 手风琴:一次只展开一个角色;null=全收起。 */
  readonly expandedRoleId: string | null
  readonly setExpandedRoleId: (roleId: string | null) => void
  readonly wizardOpen: boolean
  /** 守则草稿卡(批 2b):「用这个草稿建角色」带进向导的预填;普通「新建角色」为 null。 */
  readonly wizardPrefill: { readonly displayName: string; readonly guardrails: string } | null
  readonly openWizard: (prefill?: { readonly displayName: string; readonly guardrails: string }) => void
  readonly closeWizard: () => void
  readonly createRole: (input: CreateRoleInput) => Promise<{ readonly ok: boolean; readonly message?: string }>
  readonly renameRole: (roleId: string, displayName: string) => Promise<boolean>
  readonly archiveRole: (roleId: string) => Promise<void>
  readonly restoreRole: (roleId: string) => Promise<void>
  readonly getDeleteImpact: (roleId: string) => Promise<import('../../shared/domain').RoleDeleteImpact>
  readonly deleteRole: (
    roleId: string,
    confirmDisplayName: string,
    impactVersion: string,
  ) => Promise<DeleteRoleResult>
  /** 角色删除确认弹层:非 null 即展示(侧栏菜单与归档区共用)。 */
  readonly deleteDialogRole: RoleSummary | null
  readonly openDeleteDialog: (role: RoleSummary) => void
  readonly closeDeleteDialog: () => void
  // 守则编辑页(MainPane)
  readonly rulesRoleId: string | null
  readonly rulesDetail: RoleDetail | null
  readonly rulesLoading: boolean
  /**
   * 守则草稿预填(批 2b,PLAN §10.5):草稿卡「过目并保存」只把草稿本地预填进编辑页,
   * 用户亲手点保存才发 role:updateGuardrails;普通「编辑守则」恒为 null。
   */
  readonly rulesPrefill: string | null
  readonly openRoleRules: (roleId: string, prefillGuardrails?: string) => Promise<void>
  readonly closeRoleRules: () => void
  readonly saveGuardrails: (guardrails: string) => Promise<SaveGuardrailsResult>
  readonly openArchive: () => void
  // 聊天
  readonly messages: readonly ChatMessage[]
  readonly streaming: boolean
  /** 正在流式输出的 assistant 消息 id(message_start 置位、message_end 清空);思考块自动展开/折叠用。 */
  readonly streamingMessageId: string | null
  readonly sending: boolean
  readonly chatError: string | null
  readonly contextUsage: ContextUsageState | null
  /**
   * 输入框草稿按会话隔离(A-12):切走自动留底、切回恢复、发送后清空。
   * 无会话(null)时 draftFor 恒回 ''、setDraft 空转(此时输入框本就禁用)。
   */
  readonly draftFor: (sessionId: string | null) => string
  readonly setDraft: (sessionId: string | null, text: string) => void
  /** 应用更新状态(设置页「关于与更新」)。 */
  readonly updateState: UpdateState
  readonly checkUpdate: () => Promise<void>
  readonly downloadUpdate: () => Promise<void>
  readonly installUpdate: () => void
  readonly send: (text: string) => Promise<void>
  readonly abort: () => Promise<void>
  readonly retryLast: () => Promise<void>
  readonly lastFailedText: string | null
  // 确认卡片
  readonly approvals: readonly ApprovalCardState[]
  /** 命令实时输出(0.4.0 C):按 toolCallId 索引,CommandBlock 运行中数据源;终值并入 toolExecution.command 后清除。 */
  readonly commandLive: ReadonlyMap<string, CommandLiveChunks>
  readonly respondApproval: (
    card: ApprovalCardState,
    decision: ApprovalDecision,
    note: string,
    /** skill-candidate 批准时必传(候选数据自带的 opaque optionId);其余审批不传。 */
    selectedOptionId?: string,
  ) => Promise<void>
  // 派活卡(0.3.0,PLAN §10.2):当前打开的 manager 用户会话名下的 run 列表(其他会话恒空)
  readonly agentRuns: readonly AgentRunSummary[]
  /** 派活卡动作合集(确认响应/详情懒加载),稳定引用,直接透传到 DelegationCard。 */
  readonly delegation: DelegationCardActions
  /**
   * 协作链常驻面板(A-28,0.5.0 第三批,PLAN §6.3/§6.4):数据由这里算好推给 ChatView 的
   * CollaborationPanelHost。graph 节点=agentRuns 活体(agent_run_updated 原位实时),
   * 边=getGraph 缓存(未取回时先用依赖边顶上);无 run/非 manager 会话 graph=null,
   * 面板整体不渲染。旧整页详情(ViewMode='agent-run-detail')已收编进面板详情态。
   */
  readonly collabPanel: CollabPanelData
  readonly collabPanelActions: CollabPanelActions
  /** 受控打断(0.4.0 D):确认文案由 UI 层把守;这里发 agentRun:interrupt 并本地校正状态。 */
  readonly interruptRun: (runId: string) => Promise<void>
  // 设置与凭据
  readonly settings: Settings | null
  /** 串行链写入,resolve 成功与否(⑤审整改:失败不再被静默吞成"看似成功")。 */
  readonly selectProvider: (selection: ProviderSelection) => Promise<boolean>
  /**
   * 当前会话生效的模型选择(A-24 三层语义的解析结果:临时覆盖 > 角色默认 > 全局默认);
   * 无会话/未解析时回退全局默认。右下角切换器与 message:send 都用它。
   */
  readonly activeModelSelection: ProviderSelection | null
  /** 会话内临时切换(聊天区右下角):只写内存覆盖,不落盘、不改角色默认。 */
  readonly selectSessionProvider: (selection: ProviderSelection) => void
  /** 「存为该角色默认」:把当前会话选择写进 settings.roleModelDefaults(走串行链)。 */
  readonly saveActiveModelAsRoleDefault: () => Promise<void>
  /** 设置页角色默认模型面板:逐个角色设置/清除默认(selection=null 即「跟随全局」)。 */
  readonly setRoleModelDefault: (roleId: string, selection: ProviderSelection | null) => Promise<boolean>
  /** 启用池勾选(设置页):勾上=入池/取消=出池,整体走 settings:update;池满静默不写。 */
  readonly toggleEnabledModel: (item: ProviderSelection) => Promise<boolean>
  readonly updateThinkingLevel: (level: ThinkingLevel) => Promise<boolean>
  readonly credentials: readonly CredentialStatus[]
  readonly saveCredential: (providerId: ProviderId, apiKey: string) => Promise<boolean>
  readonly deleteCredential: (providerId: ProviderId) => Promise<void>
  readonly testCredential: (providerId: ProviderId) => Promise<ConnectivityResult>
  // 提醒
  readonly reminders: readonly Reminder[]
  readonly dismissReminder: (memoryId: string) => void
}

function humanizeError(error: unknown): string {
  if (isIpcErrorPayload(error)) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 识别捕获错误的 IPC 错误码:
 * preload 解码后把 code 放在 Error.name(见 src/main/preload.ts);
 * mock/测试可能直接抛 IpcErrorPayload 负载。两条路径都认。
 */
function hasIpcCode(error: unknown, code: IpcErrorCode): boolean {
  if (isIpcErrorPayload(error)) return error.code === code
  if (error instanceof Error) return error.name === code
  return false
}

/** 守则 expectedVersion 冲突:错误码 EROLE_CONFLICT 优先,旧文案匹配只作兜底。 */
function isGuardrailsConflict(error: unknown): boolean {
  if (hasIpcCode(error, 'EROLE_CONFLICT')) return true
  const message = humanizeError(error)
  return message.includes('刚被改过') || message.includes('重新加载最新版')
}

/**
 * 角色删除确认失效(影响清单已变/输名不一致,需重拉影响清单):
 * 错误码 EROLE_DELETE_CONFLICT 优先,文案匹配只作兜底。
 */
function isImpactStale(error: unknown): boolean {
  if (hasIpcCode(error, 'EROLE_DELETE_CONFLICT')) return true
  const message = humanizeError(error)
  return (
    message.includes('变化') ||
    message.includes('已失效') ||
    message.includes('不一致') ||
    message.includes('impact')
  )
}

/**
 * 删除未完成(主进程 ROLE_DELETE_FAILED → EINTERNAL,文案带「删除未完成」):
 * 角色已落 delete_failed 标记,前端应立刻重拉 role:list 让标记生效(B-04)。
 */
function isDeleteIncomplete(error: unknown): boolean {
  return hasIpcCode(error, 'EINTERNAL') && humanizeError(error).includes('删除未完成')
}

function appendToolExecution(
  messages: readonly ChatMessage[],
  messageId: string,
  execution: NonNullable<Extract<ChatMessage, { role: 'assistant' }>['toolExecutions']>[number],
): ChatMessage[] {
  return messages.map((m) =>
    m.id === messageId && m.role === 'assistant'
      ? { ...m, toolExecutions: [...(m.toolExecutions ?? []), execution] }
      : m,
  )
}

function updateToolExecution(
  messages: readonly ChatMessage[],
  toolCallId: string,
  status: ToolExecutionStatus,
  error?: string,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.toolExecutions) return m
    if (!m.toolExecutions.some((t) => t.toolCallId === toolCallId)) return m
    return {
      ...m,
      toolExecutions: m.toolExecutions.map((t) =>
        t.toolCallId === toolCallId ? { ...t, status, ...(error ? { error } : {}) } : t,
      ),
    }
  })
}

/** command_finished 合成终值:live 流拼接的 stdout/stderr + 事件摘要 → 完整 CommandResultDetails,挂进对应工具行。 */
export function attachCommandDetails(
  messages: readonly ChatMessage[],
  toolCallId: string,
  details: CommandResultDetails,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.toolExecutions) return m
    if (!m.toolExecutions.some((t) => t.toolCallId === toolCallId)) return m
    return {
      ...m,
      toolExecutions: m.toolExecutions.map((t) =>
        t.toolCallId === toolCallId ? { ...t, command: details } : t,
      ),
    }
  })
}

/** live chunks 按 sequence 排序拼接(乱序/重复到达安全;命令实时输出纯函数,re-export 供测试)。 */
export { joinChunks }

/** 每流滚动上限(PLAN §5.7):超过 256 KiB 丢最旧 chunk,并标 truncated。 */
const COMMAND_LIVE_STREAM_CAP = 256 * 1024

export function capChunks(chunks: Map<number, string>): { chunks: Map<number, string>; dropped: boolean } {
  let total = 0
  for (const text of chunks.values()) total += text.length
  if (total <= COMMAND_LIVE_STREAM_CAP) return { chunks, dropped: false }
  const sorted = [...chunks.entries()].sort((a, b) => a[0] - b[0])
  const kept = new Map<number, string>()
  let keptTotal = 0
  // 从最新往回收,保尾部(命令输出通常结论在最后)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const [seq, text] = sorted[i] as [number, string]
    if (keptTotal + text.length > COMMAND_LIVE_STREAM_CAP && kept.size > 0) break
    kept.set(seq, text)
    keptTotal += text.length
  }
  return { chunks: kept, dropped: true }
}

export function useAppController(bridge: DaweigeBridge): AppController {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('chat')

  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeDetail, setActiveDetail] = useState<SessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /* ---- 角色(0.2.0) ---- */
  const [roles, setRoles] = useState<readonly RoleSummary[]>([])
  /** 角色列表穿透闭包用(⑦审整改:移出池提示要查角色名,避免 useCallback 依赖抖动)。 */
  const rolesRef = useRef<readonly RoleSummary[]>([])
  rolesRef.current = roles
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [deleteDialogRole, setDeleteDialogRole] = useState<RoleSummary | null>(null)
  const [rulesRoleId, setRulesRoleId] = useState<string | null>(null)
  const [rulesDetail, setRulesDetail] = useState<RoleDetail | null>(null)
  const [rulesLoading, setRulesLoading] = useState(false)

  const [messages, setMessages] = useState<readonly ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [lastFailedText, setLastFailedText] = useState<string | null>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsageState | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })

  /**
   * 未发送草稿按 sessionId 分槽(A-12)。受控输入框的 value 必须随打字即时重渲染,
   * 所以这里用响应式 state(不可变更新),不是 ref——ref 驱动不了受控 textarea。
   */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())

  /** 全部确认卡(按会话归属);展示时按当前会话过滤,切走再切回不丢。 */
  const [allApprovals, setAllApprovals] = useState<readonly ApprovalCardState[]>([])

  /** 命令实时输出(0.4.0 C;codex 复验整改:内部键=sessionId#toolCallId 复合,防跨会话撞键混流;
   * 终值合成后清除;刷新恢复走 mapper 的 details)。 */
  const [commandLiveInternal, setCommandLiveInternal] = useState<
    ReadonlyMap<string, CommandLiveChunks>
  >(new Map())
  const commandLiveRef = useRef<ReadonlyMap<string, CommandLiveChunks>>(new Map())
  const liveKey = (sessionId: string, toolCallId: string): string => `${sessionId}#${toolCallId}`
  const updateCommandLive = useCallback(
    (
      key: string,
      mutate: (prev: CommandLiveChunks | undefined) => CommandLiveChunks | null,
    ) => {
      const next = new Map(commandLiveRef.current)
      const result = mutate(next.get(key))
      if (result === null) next.delete(key)
      else next.set(key, result)
      commandLiveRef.current = next
      setCommandLiveInternal(next)
    },
    [],
  )
  /** 当前会话可见的实时输出(复合键剥前缀;child internal 的实时流在详情页数据源,不在消息流)。 */
  const commandLive = useMemo(() => {
    const prefix = activeSessionId ? `${activeSessionId}#` : null
    if (!prefix) return new Map<string, CommandLiveChunks>()
    const view = new Map<string, CommandLiveChunks>()
    for (const [key, value] of commandLiveInternal) {
      if (key.startsWith(prefix)) view.set(key.slice(prefix.length), value)
    }
    return view
  }, [commandLiveInternal, activeSessionId])

  /* ---- 派活卡(0.3.0) ---- */
  /** 当前打开的 manager 用户会话名下的 run;切到普通会话即清空(只在 manager 会话打开时拉)。 */
  const [agentRuns, setAgentRuns] = useState<readonly AgentRunSummary[]>([])
  /** delegation 确认请求,按 runId 索引;awaiting 派活卡的确认内容/响应入口。 */
  const [delegationRequests, setDelegationRequests] = useState<
    ReadonlyMap<string, { readonly request: DelegationApprovalRequest; readonly responded: boolean }>
  >(new Map())
  /** 已取回的派活详情(结论摘要/展开细节/面板 tab 过程共用一份缓存)。 */
  const [runDetails, setRunDetails] = useState<ReadonlyMap<string, AgentRunDetail>>(new Map())
  const [runDetailLoading, setRunDetailLoading] = useState<ReadonlySet<string>>(new Set())
  /** 协作链整图(0.4.0 D)按 graphId 缓存;图状态由 DTO 推导,本地只当视图缓存不存第二份真相。 */
  const [agentGraphs, setAgentGraphs] = useState<ReadonlyMap<string, AgentRunGraph>>(new Map())
  const [graphLoadingIds, setGraphLoadingIds] = useState<ReadonlySet<string>>(new Set())
  /** 打断在途(0.4.0 D):防重复点击;终态返回后自动解锁。 */
  const [interruptBusy, setInterruptBusy] = useState<ReadonlySet<string>>(new Set())
  /** 图缓存镜像(事件回调里判断「是否已拉过」用,不读旧闭包)。 */
  const agentGraphsRef = useRef<ReadonlyMap<string, AgentRunGraph>>(new Map())
  agentGraphsRef.current = agentGraphs
  /** 打断在途镜像(interruptRun 的重入守卫读 ref,state 只喂 UI 禁用态)。 */
  const interruptBusyRef = useRef<ReadonlySet<string>>(new Set())
  interruptBusyRef.current = interruptBusy
  /** 详情缓存镜像(A-28:事件回调里判断「这条 run 缓存过没有」决定标脏还是刷新,不读旧闭包)。 */
  const runDetailsRef = useRef<ReadonlyMap<string, AgentRunDetail>>(new Map())
  runDetailsRef.current = runDetails
  /**
   * 已缓存但内容已落后的 run(A-28,PLAN §6.4-3):状态 push/internal 事件触到非选中 tab
   * 时不后台拉详情,只在这里记脏;面板打开/切 tab 时命中脏标才重拉。
   */
  const runDetailStaleRef = useRef<ReadonlySet<string>>(new Set())

  const [settings, setSettings] = useState<Settings | null>(null)
  const [credentials, setCredentials] = useState<readonly CredentialStatus[]>([])
  const [reminders, setReminders] = useState<readonly Reminder[]>([])
  const [dismissedReminders, setDismissedReminders] = useState<readonly string[]>([])

  // 事件回调里要读最新值,用 ref 穿透闭包。
  const activeSessionIdRef = useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId
  const activeDetailRef = useRef<SessionDetail | null>(null)
  activeDetailRef.current = activeDetail
  const streamingMessageIdRef = useRef<string | null>(null)
  const lastUserTextRef = useRef<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const settingsRef = useRef<Settings | null>(null)
  settingsRef.current = settings
  /**
   * settings 写入串行链(codex 复审整改):settings:update 是整份快照写回,
   * 并发写会互相覆盖(快速连续勾选丢勾、旧响应回滚新状态)。
   * 所有变更排队执行;链内维护权威最新值——setSettings 后 re-render 是异步的,
   * 链内下一步不能读 settingsRef(它还是旧值),只能读链尾值。
   */
  const settingsChain = useRef<{ promise: Promise<boolean>; latest: Settings | null }>({
    promise: Promise.resolve(false),
    latest: null,
  })
  /**
   * 会话临时模型覆盖(A-24,PLAN §1.1-5):按 sessionId 存内存,不持久化、不改角色默认;
   * 重启后重新按角色默认解析。
   */
  const sessionModelOverridesRef = useRef<Map<string, ProviderSelection>>(new Map())
  /** 当前会话生效的模型选择(右下角切换器与 message:send 的数据源)。 */
  const [activeModelSelection, setActiveModelSelection] = useState<ProviderSelection | null>(null)
  const activeModelSelectionRef = useRef<ProviderSelection | null>(null)
  activeModelSelectionRef.current = activeModelSelection
  const sessionsRef = useRef<readonly SessionSummary[]>([])
  sessionsRef.current = sessions
  /** agentRuns 属于哪条 manager 会话(事件 upsert 按它过滤);非 manager 会话为 null。 */
  const agentRunsSessionRef = useRef<string | null>(null)
  /** 详情加载中的同步去重守卫(StrictMode 双跑 effect 也只发一次 getDetail)。 */
  const runDetailLoadingRef = useRef<ReadonlySet<string>>(new Set())
  /**
   * 闭合复核(并发窗口):getDetail 在途期间又收到刷新触发时记 dirty 标;
   * 当前请求落地后若标还在,尾随再拉一次——慢请求撞上 500ms 定时器/agent_run_updated 不丢刷新。
   */
  const runDetailDirtyRef = useRef<ReadonlySet<string>>(new Set())
  /** agentRuns 最新值(整页详情打开入口要按 runId 找活体,事件回调外用 ref 穿透)。 */
  const agentRunsRef = useRef<readonly AgentRunSummary[]>([])
  agentRunsRef.current = agentRuns
  /** 图在途/失效标(0.4.0 D):并发去重 + agent_run_updated 后的重拉触发,形态对齐 runDetail 的 loading/dirty。 */
  const graphLoadingRef = useRef<ReadonlySet<string>>(new Set())
  const graphsDirtyRef = useRef<ReadonlySet<string>>(new Set())
  /** 图代次(codex 复验整改):标脏时 +1;在途请求的响应只有代次未变才有资格清脏标——
   * 防旧响应把标脏误清、尾随重拉被吞(族谱不再卡旧快照)。 */
  const graphEpochRef = useRef<ReadonlyMap<string, number>>(new Map())

  const markGraphDirty = useCallback((graphId: string) => {
    const nextDirty = new Set(graphsDirtyRef.current)
    nextDirty.add(graphId)
    graphsDirtyRef.current = nextDirty
    graphEpochRef.current = new Map(graphEpochRef.current).set(
      graphId,
      (graphEpochRef.current.get(graphId) ?? 0) + 1,
    )
  }, [])

  /* ---- 守则草稿预填(批 2b,PLAN §10.5) ---- */
  /** 「用这个草稿建角色」带进向导的预填;普通「新建角色」为 null。 */
  const [wizardPrefill, setWizardPrefill] = useState<{
    readonly displayName: string
    readonly guardrails: string
  } | null>(null)
  /** 「过目并保存」带进守则编辑页的预填正文;普通「编辑守则」为 null。 */
  const [rulesPrefill, setRulesPrefill] = useState<string | null>(null)

  /* ---- 协作链常驻面板(A-28,0.5.0 第三批,PLAN §6.2/§6.4) ---- */
  /** 显式 pin(规则 3):消息流派活卡「查看完整过程」把这条链+这个 tab 钉住;切会话清(规则 5)。 */
  const [panelPinned, setPanelPinned] = useState<{
    readonly graphId: string
    readonly runId: string
  } | null>(null)
  /** 手动收起(小窗态);有活跃 run 的新 push 会自动展开(面板态默认)。 */
  const [panelMinimized, setPanelMinimized] = useState(false)
  /** 手动展开(小窗态展开图标):全终态空闲链也能点回面板态;新活跃 push/收起/切会话时清回自动档。 */
  const [panelManualExpanded, setPanelManualExpanded] = useState(false)
  /** 详情态开关(PLAN 接口名 panelExpanded;语义=右侧详情页展开)。 */
  const [panelDetailOpen, setPanelDetailOpen] = useState(false)
  /** 当前 tab(未回退的原值;存在性回退在 collabPanel memo 里做)。 */
  const [panelSelectedRunId, setPanelSelectedRunId] = useState<string | null>(null)
  /** 以下 ref 供事件回调穿透闭包读最新值(state 落渲染是异步的)。 */
  const panelPinnedRef = useRef<{ readonly graphId: string; readonly runId: string } | null>(null)
  panelPinnedRef.current = panelPinned
  const panelSelectedRunIdRef = useRef<string | null>(null)
  panelSelectedRunIdRef.current = panelSelectedRunId
  const panelDetailOpenRef = useRef(false)
  panelDetailOpenRef.current = panelDetailOpen
  /** 正在显示的链(⑤审整改):详情态沿用它,防新链 push 顶替正在看的详情;切会话随 pin 一起清。 */
  const panelShownGraphIdRef = useRef<string | null>(null)
  /**
   * 详情态打开时 child(internal)干活事件的防抖同步计时器(0.3.0 严重-2 整改沿用):
   * 非 null 表示 500ms 窗口内已挂起一次重拉,窗口内后续事件合并掉。
   */
  const runDetailSyncTimerRef = useRef<number | null>(null)
  /** usage_updated 防抖计时器(初审-严重,PLAN §9.2):200ms 窗口合并成一次重拉。 */
  const usageSyncTimerRef = useRef<number | null>(null)

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3200)
  }, [])

  /**
   * settings 变更统一入口(串行链,见 settingsChain 注释):
   * mutate 基于链内最新值计算下一份快照,返回原引用表示无事可做;
   * 先本地生效、IPC 成功采用服务端返回、失败回滚到链内最新值。
   * silent=true 失败不弹提示(尽力而为型写入,如记住上次会话)。
   */
  const enqueueSettingsMutation = useCallback(
    (mutate: (current: Settings) => Settings, opts?: { silent?: boolean }): Promise<boolean> => {
      const prev = settingsChain.current
      const run = prev.promise.then(async (): Promise<boolean> => {
        const current = settingsChain.current.latest ?? settingsRef.current
        if (!current) return false
        const next = mutate(current)
        if (next === current) return true
        setSettings(next)
        try {
          const saved = await bridge.invoke('settings:update', { settings: next })
          settingsChain.current.latest = saved
          setSettings(saved)
          return true
        } catch (error) {
          settingsChain.current.latest = current
          setSettings(current)
          if (!opts?.silent) showNotice(humanizeError(error))
          return false
        }
      })
      settingsChain.current = { promise: run, latest: prev.latest }
      return run
    },
    [bridge, showNotice],
  )

  /**
   * 解析某会话当前该用的模型(A-24 三层语义):
   * 会话临时覆盖(内存)→ 角色默认(settings.roleModelDefaults)→ 全局默认。
   * 读链尾/Ref 里的最新 settings,不等 re-render(bootstrap 自动开会话时 setSettings 尚未落渲染)。
   */
  const resolveSessionSelection = useCallback(
    (sessionId: string, roleId: string | null): ProviderSelection | null => {
      const override = sessionModelOverridesRef.current.get(sessionId)
      if (override !== undefined) return override
      const current = settingsChain.current.latest ?? settingsRef.current
      if (current === null) return null
      if (roleId === null) return current.providerSelection
      return resolveRoleModel(current, roleId).selection
    },
    [],
  )

  const applyDetail = useCallback(
    (detail: SessionDetail) => {
      setActiveDetail(detail)
      setActiveSessionId(detail.summary.id)
      setMessages(detail.messages)
      // A-24:开会话即解析当前生效模型(临时覆盖 > 角色默认 > 全局默认)
      setActiveModelSelection(resolveSessionSelection(detail.summary.id, detail.summary.roleId))
      setStreaming(false)
      setChatError(null)
      setLastFailedText(null)
      setContextUsage(null) // 切换会话时清空用量环
      streamingMessageIdRef.current = null
      setStreamingMessageId(null)
      // A-28(PLAN §6.2 规则 5):切会话清掉面板 pin/选中/展开与脏标——
      // 面板状态随新会话的 run 列表整体重算,不把上一条 manager 会话的链带过去
      setPanelPinned(null)
      panelShownGraphIdRef.current = null
      setPanelSelectedRunId(null)
      setPanelDetailOpen(false)
      setPanelMinimized(false)
      setPanelManualExpanded(false)
      runDetailStaleRef.current = new Set()
      // 手风琴:当前会话所属角色自动展开
      if (detail.summary.roleId !== null) setExpandedRoleId(detail.summary.roleId)
      // 0.3.0(PLAN §10.2):只在 manager 用户会话打开时拉派活卡;普通会话清空。
      // 判定用内置总管固定 ID(常量),不读 bootstrap state——bootstrap 首次打开入口会话时
      // setBootstrap 还没落渲染,读 state/ref 会拿到 null 而漏拉。
      if (detail.summary.roleId === SYSTEM_MANAGER_ROLE_ID) {
        const sessionId = detail.summary.id
        agentRunsSessionRef.current = sessionId
        setAgentRuns([])
        bridge
          .invoke('agentRun:list', { managerSessionId: sessionId })
          .then((runs) => {
            // 拉回时用户可能已切走,只认仍是当前 run 会话的结果
            if (agentRunsSessionRef.current === sessionId) setAgentRuns([...runs])
          })
          .catch(() => {
            if (agentRunsSessionRef.current === sessionId) setAgentRuns([])
          })
      } else {
        agentRunsSessionRef.current = null
        setAgentRuns([])
      }
    },
    [bridge, resolveSessionSelection],
  )

  const openSession = useCallback(
    async (sessionId: string) => {
      setDetailLoading(true)
      setChatError(null)
      try {
        const detail = await bridge.invoke('session:open', { sessionId })
        applyDetail(detail)
        setView('chat') // 点会话切回聊天(从使用统计/设置页回来时)
        // 记住上次活跃会话(尽力而为:串行链上静默写入,不与设置页勾选等并发写互相覆盖)。
        void enqueueSettingsMutation(
          (current) => ({ ...current, lastActiveSessionId: sessionId }),
          { silent: true },
        )
      } catch (error) {
        setChatError(humanizeError(error))
      } finally {
        setDetailLoading(false)
      }
    },
    [bridge, applyDetail, enqueueSettingsMutation],
  )

  const bootstrapOnce = useCallback(async () => {
    setBootstrapError(null)
    try {
      const state = await bridge.invoke('app:getBootstrapState', undefined)
      setBootstrap(state)
      // 防御性拷贝:桥另一侧可能复用/再变数组(mock 即如此),state 里只放自己的快照
      setRoles([...state.roles])
      setSessions([...state.sessions])
      setSettings(state.settings)
      // A-24(PLAN §1.1 末尾):自动打开会话前先同步 ref/串行链——setSettings 重渲染是异步的,
      // 紧跟着的 openSession 解析角色默认时读 ref/链尾,不同步会拿到 null 回退错模型
      settingsRef.current = state.settings
      settingsChain.current.latest = state.settings
      setCredentials(state.credentialStatuses)
      setReminders(state.upcomingReminders)
      const managerEntryId = state.manager?.entrySessionId ?? null
      if (managerEntryId !== null) {
        // 0.3.0(PLAN §4.4):bootstrap 给了总管入口会话,无条件优先打开它,
        // 优先级高于 lastActiveSessionId;入口缺失/已归档不虚构会话、
        // 也不退回 worker 的上次会话,落空 chat 由用户自己点。
        const entry = state.sessions.find((s) => s.id === managerEntryId)
        if (entry !== undefined && entry.archivedAt === null) {
          await openSession(entry.id)
        }
      } else {
        // 总管降级(manager=null):保持 0.2.0 现有行为,恢复上次活跃会话
        const lastId = state.settings.lastActiveSessionId
        const last = lastId ? state.sessions.find((s) => s.id === lastId) : undefined
        // 恢复上次活跃会话:会话本身或其角色已归档则不恢复,落空 chat
        const lastRole = last?.roleId ? state.roles.find((r) => r.id === last.roleId) : undefined
        const restorable =
          last !== undefined &&
          last.archivedAt === null &&
          (last.roleId === null || (lastRole !== undefined && lastRole.archivedAt === null))
        if (lastId && restorable) {
          await openSession(lastId)
        }
      }
    } catch (error) {
      setBootstrapError(humanizeError(error))
    }
  }, [bridge, openSession])

  useEffect(() => {
    void bootstrapOnce()
  }, [bootstrapOnce])

  /**
   * 角色默认/启用池变化后的跟随规则(A-24,PLAN §2.2-6):
   * - 当前会话无临时覆盖:立即跟随新默认(角色默认或全局);
   * - 有临时覆盖:保持临时值;
   * - 覆盖模型被移出启用池:清掉覆盖、回退默认并弹一次提示(覆盖已删,不会重复弹)。
   */
  useEffect(() => {
    if (settings === null) return
    const sessionId = activeSessionId
    if (sessionId === null) {
      setActiveModelSelection(settings.providerSelection)
      return
    }
    const roleId = activeDetail?.summary.roleId ?? null
    const resolved =
      roleId === null
        ? settings.providerSelection
        : resolveRoleModel(settings, roleId).selection
    const override = sessionModelOverridesRef.current.get(sessionId)
    if (override === undefined) {
      setActiveModelSelection(resolved)
      return
    }
    if (!isEnabledModel(settings, override)) {
      sessionModelOverridesRef.current.delete(sessionId)
      setActiveModelSelection(resolved)
      showNotice('临时切换的模型已不在常用池,本会话回退到默认模型。')
      return
    }
    setActiveModelSelection(override)
  }, [settings, activeSessionId, activeDetail, showNotice])

  /**
   * 派活详情拉取(结论摘要/展开细节/面板 tab 过程/详情态实时刷新共用);
   * 加载中的重复调用直接跳过(同步守卫,StrictMode 双跑也只发一次)。
   * 放在事件流之前定义:agent_run_updated 里要复用它刷新选中 tab(A-28)。
   */
  const loadRunDetail = useCallback(
    (runId: string) => {
      // 同 run 请求在途:不丢触发,记 dirty 标,等当前请求落地后尾随重拉(闭合复核)
      if (runDetailLoadingRef.current.has(runId)) {
        const nextDirty = new Set(runDetailDirtyRef.current)
        nextDirty.add(runId)
        runDetailDirtyRef.current = nextDirty
        return
      }
      const nextLoading = new Set(runDetailLoadingRef.current)
      nextLoading.add(runId)
      runDetailLoadingRef.current = nextLoading
      setRunDetailLoading(nextLoading)
      const settleLoading = () => {
        const next = new Set(runDetailLoadingRef.current)
        next.delete(runId)
        runDetailLoadingRef.current = next
        setRunDetailLoading(next)
        // 在途期间攒下的触发:清标后尾随再拉一次,以主进程最新快照为准
        if (runDetailDirtyRef.current.has(runId)) {
          const nextDirty = new Set(runDetailDirtyRef.current)
          nextDirty.delete(runId)
          runDetailDirtyRef.current = nextDirty
          loadRunDetail(runId)
        }
      }
      bridge
        .invoke('agentRun:getDetail', { runId, managerSessionId: agentRunsSessionRef.current ?? '' })
        .then((detail) => {
          setRunDetails((prev) => new Map(prev).set(runId, detail))
        })
        .catch(() => {
          // 取详情失败不弹全局错:卡内保留「再点一次试试」的入口
        })
        .finally(settleLoading)
    },
    [bridge],
  )

  /**
   * 协作链整图懒加载(0.4.0 D):打开详情时才按需取,graphId 键缓存;
   * agent_run_updated 触到已缓存链 → 标脏重拉(刷新时以主进程 DTO 为准)。
   * 并发去重与尾随重拉同 loadRunDetail 一套形态。
   */
  const loadAgentGraph = useCallback(
    (graphId: string) => {
      // 已缓存且没标脏:命中缓存不重拉(重拉只发生在推送变脏或首次打开)
      if (
        agentGraphsRef.current.has(graphId) &&
        !graphsDirtyRef.current.has(graphId)
      ) {
        return
      }
      if (graphLoadingRef.current.has(graphId)) {
        const nextDirty = new Set(graphsDirtyRef.current)
        nextDirty.add(graphId)
        graphsDirtyRef.current = nextDirty
        return
      }
      const nextLoading = new Set(graphLoadingRef.current)
      nextLoading.add(graphId)
      graphLoadingRef.current = nextLoading
      setGraphLoadingIds(nextLoading)
      // 请求发出时的代次:响应回来若代次已涨(在途期间有事件标脏),无权清脏标——
      // 由 settle 的尾随重拉保证族谱刷到新状态(codex 复验整改)
      const requestEpoch = graphEpochRef.current.get(graphId) ?? 0
      const settle = () => {
        const rest = new Set(graphLoadingRef.current)
        rest.delete(graphId)
        graphLoadingRef.current = rest
        setGraphLoadingIds(rest)
        // 在途期间链上又有状态变化:尾随再拉一次,族谱不落在旧快照上
        if (graphsDirtyRef.current.has(graphId)) {
          const nextDirty = new Set(graphsDirtyRef.current)
          nextDirty.delete(graphId)
          graphsDirtyRef.current = nextDirty
          loadAgentGraph(graphId)
        }
      }
      const managerSessionId = agentRunsSessionRef.current
      if (managerSessionId === null) {
        // 不在 manager 会话(理论到不了:run 列表只在 manager 会话加载),直接放弃避免空归属请求
        settle()
        return
      }
      bridge
        .invoke('agentRun:getGraph', { graphId, managerSessionId })
        .then((graph) => {
          setAgentGraphs((prev) => new Map(prev).set(graph.graphId, graph))
          // 代次未变才清脏标:旧响应不得吞掉在途事件触发的刷新
          if ((graphEpochRef.current.get(graphId) ?? 0) === requestEpoch) {
            graphsDirtyRef.current = new Set(
              [...graphsDirtyRef.current].filter((id) => id !== graphId),
            )
          }
        })
        .catch(() => {
          // 图谱取不到不打断详情页主体:区块保持隐藏/弱提示,下次打开或推送再试
        })
        .finally(settle)
    },
    [bridge],
  )

  /** 同 graph 已知 run 数 >1 才值得拉图(handoff 边只有 getGraph 知道);单节点图本地合成即可。 */
  const ensureGraphForRun = useCallback(
    (run: AgentRunSummary) => {
      const peerCount = agentRunsRef.current.filter((r) => r.graphId === run.graphId).length
      if (peerCount > 1) loadAgentGraph(run.graphId)
    },
    [loadAgentGraph],
  )

  /** 标脏一条已缓存详情(A-28,PLAN §6.4-3):未选中 tab 不后台拉,下次点开再取。 */
  const markRunDetailStale = useCallback((runId: string) => {
    if (runDetailStaleRef.current.has(runId)) return
    runDetailStaleRef.current = new Set(runDetailStaleRef.current).add(runId)
  }, [])

  /** 面板打开/切 tab 时的取详情门槛:没缓存或已标脏才拉(loadRunDetail 自带在途去重)。 */
  const ensureRunDetailFresh = useCallback(
    (runId: string) => {
      if (runDetailsRef.current.has(runId) && !runDetailStaleRef.current.has(runId)) return
      runDetailStaleRef.current = new Set(
        [...runDetailStaleRef.current].filter((id) => id !== runId),
      )
      loadRunDetail(runId)
    },
    [loadRunDetail],
  )

  /**
   * 当前面板(链,tab)的同步解析(事件回调/动作里用,不等渲染):
   * 与 collabPanel memo 同一套纯函数,数据源换成 ref 里的最新 run 列表/pin。
   */
  const resolvePanelSelection = useCallback((): {
    readonly graphId: string | null
    readonly runId: string | null
  } => {
    const runs = agentRunsRef.current
    const graphId = resolvePanelGraphId(runs, panelPinnedRef.current?.graphId ?? null)
    if (graphId === null) return { graphId: null, runId: null }
    const nodes = runs.filter((r) => r.graphId === graphId)
    return { graphId, runId: resolveSelectedRunId(nodes, panelSelectedRunIdRef.current) }
  }, [])

  /* ============ agent 事件流 ============ */
  /**
   * 严重-2(0.3.0 整改,PLAN §7.2)+ A-28(PLAN §6.4-2):面板详情态打开时,选中 tab 那条
   * child 的 internal 会话事件(text_delta/thinking_delta/message_end/tool_start/tool_end 等)
   * 轻量路由到这里——短防抖后重拉 agentRun:getDetail,以主进程快照为准(renderer 不手拼
   * 流式 delta,不会与 pi 持久化竞态)。500ms 窗口内事件合并成一次;详情收起/切走会话即停(触发时校验)。
   */
  const scheduleRunDetailSync = useCallback(
    (runId: string) => {
      if (runDetailSyncTimerRef.current !== null) return
      runDetailSyncTimerRef.current = window.setTimeout(() => {
        runDetailSyncTimerRef.current = null
        // 详情态已收起或 tab 已切走:挂起的同步作废
        if (!panelDetailOpenRef.current || panelSelectedRunIdRef.current !== runId) return
        loadRunDetail(runId)
      }, 500)
    },
    [loadRunDetail],
  )

  /**
   * 初审-严重(0.3.0 追加整改,PLAN §9.2):usage_updated 防抖 200ms 重拉。
   * usage 落库可能晚于终态 agent_run_updated——不重拉的话 completed 派活卡会永远停在
   * 「轮次 0 · 总 token 0」。只在 manager 会话 run 列表已加载时重拉列表(失败静默);
   * 面板详情态开着就同时重拉选中 tab 的 getDetail(A-28)。
   */
  const scheduleUsageSync = useCallback(() => {
    if (usageSyncTimerRef.current !== null) return
    usageSyncTimerRef.current = window.setTimeout(() => {
      usageSyncTimerRef.current = null
      const managerSessionId = agentRunsSessionRef.current
      if (managerSessionId !== null) {
        bridge
          .invoke('agentRun:list', { managerSessionId })
          .then((runs) => {
            // 拉回时用户可能已切走,只认仍是当前 run 会话的结果
            if (agentRunsSessionRef.current === managerSessionId) setAgentRuns([...runs])
          })
          .catch(() => undefined)
      }
      if (panelDetailOpenRef.current) {
        const selectedRunId = panelSelectedRunIdRef.current
        if (selectedRunId !== null) loadRunDetail(selectedRunId)
      }
    }, 200)
  }, [bridge, loadRunDetail])

  /** memory_changed 防抖计时器(0.6.0 F2):400ms 窗口合并成一次提醒重拉。 */
  const reminderSyncTimerRef = useRef<number | null>(null)

  /**
   * 记忆变化(0.6.0):删除/清空/迁移会影响启动提醒列表,防抖重拉 reminder:listUpcoming;
   * 已点掉提醒的条目若被删,从点掉名单里一并清掉(名单不挂孤儿)。
   */
  const scheduleReminderSync = useCallback(() => {
    if (reminderSyncTimerRef.current !== null) return
    reminderSyncTimerRef.current = window.setTimeout(() => {
      reminderSyncTimerRef.current = null
      bridge
        .invoke('reminder:listUpcoming', undefined)
        .then((list) => {
          setReminders([...list])
          const alive = new Set(list.map((r) => r.memoryId))
          setDismissedReminders((prev) => prev.filter((id) => alive.has(id)))
        })
        .catch(() => undefined)
    }, 400)
  }, [bridge])

  useEffect(() => {
    const unsubscribe = bridge.onAgentEvent((event: AgentPushEvent) => {
      // 更新状态是应用级事件,与会话无关
      if (event.type === 'update_state') {
        setUpdateState(event.state)
        return
      }
      // usage 更新通知(初审-严重,PLAN §9.2):防抖重拉 run 列表/详情,补齐晚落库的用量
      if (event.type === 'usage_updated') {
        scheduleUsageSync()
        return
      }
      // 记忆变化(0.6.0 F2):事件没有 sessionId 和正文,必须在读 event.sessionId 的分流之前处理;
      // 这里只防抖重拉提醒,记忆面板自身的重拉由面板订阅负责
      if (event.type === 'memory_changed') {
        scheduleReminderSync()
        return
      }
      // 派活状态变化(0.3.0):upsert 进当前 manager 会话的 run 列表,卡片原位变状态(PLAN §10.2)
      if (event.type === 'agent_run_updated') {
        const run = event.run
        if (run.managerSessionId === agentRunsSessionRef.current) {
          const known = agentRunsRef.current.some((r) => r.runId === run.runId)
          setAgentRuns((prev) => {
            const index = prev.findIndex((r) => r.runId === run.runId)
            if (index < 0) return [...prev, run]
            const next = [...prev]
            next[index] = run
            return next
          })
          // A-28(线框图规则):新出现的非终态 run 自动展开面板并回到自动档
          // (用户手动收起过的老 run 翻面不再顶开;手动展开档也不滞留到新链上)
          if (!known && !isTerminalRunStatus(run.status)) {
            setPanelMinimized(false)
            setPanelManualExpanded(false)
          }
        }
        // A-28(PLAN §6.4-1):详情态选中 tab 正是这条 run → 重拉 getDetail 恢复完整历史;
        // 其余已缓存的 run 只标脏不后台拉(PLAN §6.4-3),下次点开再取
        if (panelDetailOpenRef.current && panelSelectedRunIdRef.current === run.runId) {
          loadRunDetail(run.runId)
        } else if (runDetailsRef.current.has(run.runId)) {
          markRunDetailStale(run.runId)
        }
        // 协作链(0.4.0 D):链上任何节点的状态变化都让图变脏;
        // 已缓存就重拉(面板/族谱跟着活),没缓存只记脏标——等下次需要时按需取
        markGraphDirty(run.graphId)
        if (agentGraphsRef.current.has(run.graphId)) loadAgentGraph(run.graphId)
        return
      }
      // A-29(PLAN §7.3-8):压缩完成提示——notice 并入当前会话消息流(同 id 去重;
      // 非当前会话不处理,下次打开由 session:open 映射回来);用量环同步到压缩后真实占用
      if (event.type === 'context_compacted') {
        if (event.sessionId === activeSessionIdRef.current) {
          const notice = event.notice
          setMessages((prev) => (prev.some((m) => m.id === notice.id) ? prev : [...prev, notice]))
          setContextUsage(event.contextUsage)
        }
        return
      }
      // 严重-2(0.3.0 整改)+ A-28(PLAN §6.4-2):面板详情态打开期间,选中 tab 那条
      // child internal 会话的干活事件防抖 500ms 重拉详情——运行中盯着 tab 能看到过程持续推进。
      // 详情收起时落在已缓存详情上的事件只标脏,不后台拉(PLAN §6.4-3)。
      if (
        event.type === 'message_start' ||
        event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'message_end' ||
        event.type === 'tool_start' ||
        event.type === 'tool_end'
      ) {
        if (panelDetailOpenRef.current) {
          const selectedRunId = panelSelectedRunIdRef.current
          if (selectedRunId !== null) {
            const internalSessionId =
              agentRunsRef.current.find((r) => r.runId === selectedRunId)?.internalSessionId ?? null
            if (internalSessionId !== null && event.sessionId === internalSessionId) {
              scheduleRunDetailSync(selectedRunId)
            }
          }
        } else {
          const hit = agentRunsRef.current.find((r) => r.internalSessionId === event.sessionId)
          if (hit !== undefined && runDetailsRef.current.has(hit.runId)) {
            markRunDetailStale(hit.runId)
          }
        }
      }
      // 确认类事件(approval_*/tool_*)不限会话记录——卡片按会话归属保存,
      // 切走的会话弹确认卡也不丢(复审 S-01);消息流事件只处理当前会话。
      const isCurrentSession = event.sessionId === activeSessionIdRef.current
      switch (event.type) {
        case 'approval_required': {
          // delegation(0.3.0)不进文件卡浮层:渲染并入对应派活卡(PLAN §6.2/§10.4),
          // 这里按 runId 存好请求,awaiting 派活卡从 delegation.approvalFor 取
          if (event.request.kind === 'delegation') {
            const request = event.request
            setDelegationRequests((prev) =>
              new Map(prev).set(request.runId, { request, responded: false }),
            )
            break
          }
          // 技能候选/安装卡(0.7.0)与其他卡同入浮层列表,kind 路由在 ChatView 完成;
          // command(0.4.0 C)卡先并入通用浮层最小过渡(C4 前端批再换 CommandApprovalCard 专用渲染)
          const request = event.request
          setAllApprovals((prev) => [
            ...prev,
            {
              sessionId: event.sessionId,
              surfaceSessionId: event.surfaceSessionId ?? event.sessionId,
              request,
              phase: 'pending',
              responded: false,
            },
          ])
          break
        }
        case 'approval_resolved':
          setAllApprovals((prev) =>
            prev.map((card) =>
              card.request.id === event.approvalId
                ? {
                    ...card,
                    responded: true,
                    decision: event.decision,
                    phase: event.decision === 'approve' ? 'running' : 'rejected',
                  }
                : card,
            ),
          )
          // delegation 的已决回执:标 responded,卡片状态等 agent_run_updated 来翻
          setDelegationRequests((prev) => {
            for (const entry of prev.values()) {
              if (entry.request.id !== event.approvalId) continue
              const next = new Map(prev)
              next.set(entry.request.runId, { ...entry, responded: true })
              return next
            }
            return prev
          })
          break
        case 'tool_start':
          // 消息流只认当前会话:跨会话的 messageId/toolCallId 不得误挂到本会话消息上(codex 复验整改)
          if (!isCurrentSession) break
          setMessages((prev) => appendToolExecution(prev, event.messageId, event.execution))
          break
        case 'tool_end':
          // 工具行只动当前会话的;确认卡按 (sessionId, toolCallId) 双条件翻态——
          // 跨会话同名 toolCallId 不得把别人的行/卡错误翻成终态(codex 复验整改)
          if (isCurrentSession) {
            setMessages((prev) =>
              updateToolExecution(prev, event.toolCallId, event.status, event.error),
            )
          }
          // 工具终态(命令失败/被拒/中止):onFinished 缺席路径的 live 兜底清理,防残留转圈
          if (event.status === 'failed' || event.status === 'rejected') {
            updateCommandLive(liveKey(event.sessionId, event.toolCallId), () => null)
          }
          setAllApprovals((prev) =>
            prev.map((card) =>
              card.request.toolCallId === event.toolCallId &&
              card.sessionId === event.sessionId &&
              card.phase === 'running'
                ? {
                    ...card,
                    phase: event.status,
                    ...(event.error ? { error: event.error } : {}),
                  }
                : card,
            ),
          )
          break
        case 'command_output': {
          // 异源拒收(codex 复验整改):只收当前打开会话与当前 manager 名下 child internal 的流;
          // 无关会话的输出(即使 toolCallId 碰撞)不进全局 commandLive 状态
          const owned =
            event.sessionId === activeSessionIdRef.current ||
            agentRunsRef.current.some((run) => run.internalSessionId === event.sessionId)
          if (!owned) break
          // 会话隔离:复合键 sessionId#toolCallId,跨会话同 toolCallId 不混流(codex 复验整改)
          const { stream, sequence, chunk } = event
          const ownerSessionId = event.sessionId
          updateCommandLive(liveKey(event.sessionId, event.toolCallId), (prev) => {
            // 同键但归属漂移(理论不到):以首归属为准,拒收异源
            if (prev !== undefined && prev.sessionId !== ownerSessionId) return prev
            const chunks = new Map(prev?.[stream] ?? new Map<number, string>())
            chunks.set(sequence, chunk)
            const { chunks: capped, dropped } = capChunks(chunks)
            return {
              sessionId: ownerSessionId,
              stdout: stream === 'stdout' ? capped : (prev?.stdout ?? new Map<number, string>()),
              stderr: stream === 'stderr' ? capped : (prev?.stderr ?? new Map<number, string>()),
              stdoutTruncated: (prev?.stdoutTruncated ?? false) || (stream === 'stdout' && dropped),
              stderrTruncated: (prev?.stderrTruncated ?? false) || (stream === 'stderr' && dropped),
            }
          })
          break
        }
        case 'command_finished': {
          // 终值只挂"当前打开会话自己"的命令(child 的终值走详情页数据源,不进 manager 消息流;
          // 防跨会话同 toolCallId 时把别人的终值挂到本会话消息上)
          if (event.sessionId !== activeSessionIdRef.current) break
          // 终值:live 流拼接 stdout/stderr + 事件摘要 → 合成完整 details 挂进工具行,清 live。
          // renderer 侧 256KiB 滚动截断(保尾部)按流并入截断标记,完成态不静默丢输出
          const live = commandLiveRef.current.get(liveKey(event.sessionId, event.toolCallId))
          const details: CommandResultDetails = {
            ...event.result,
            stdout: live ? joinChunks(live.stdout) : '',
            stderr: live ? joinChunks(live.stderr) : '',
            stdoutTruncated: (event.result.stdoutTruncated ?? false) || (live?.stdoutTruncated ?? false),
            stderrTruncated: (event.result.stderrTruncated ?? false) || (live?.stderrTruncated ?? false),
          }
          setMessages((prev) => attachCommandDetails(prev, event.toolCallId, details))
          updateCommandLive(liveKey(event.sessionId, event.toolCallId), () => null)
          break
        }
        default: {
          if (!isCurrentSession) return
          handleChatEvent(event)
        }
      }
    })
    return () => {
      unsubscribe()
      // 组件卸载(或桥换实例)时停掉挂起的详情/用量同步
      if (runDetailSyncTimerRef.current !== null) {
        window.clearTimeout(runDetailSyncTimerRef.current)
        runDetailSyncTimerRef.current = null
      }
      if (usageSyncTimerRef.current !== null) {
        window.clearTimeout(usageSyncTimerRef.current)
        usageSyncTimerRef.current = null
      }
      if (reminderSyncTimerRef.current !== null) {
        window.clearTimeout(reminderSyncTimerRef.current)
        reminderSyncTimerRef.current = null
      }
    }
  }, [bridge, loadRunDetail, loadAgentGraph, markGraphDirty, markRunDetailStale, scheduleRunDetailSync, scheduleUsageSync, scheduleReminderSync])

  /** 当前会话的消息流事件(message 系列、agent_error、agent_end)。 */
  const handleChatEvent = (event: AgentPushEvent): void => {
    switch (event.type) {
      case 'message_start':
        streamingMessageIdRef.current = event.messageId
        setStreamingMessageId(event.messageId)
        setStreaming(true)
        setMessages((prev) => [
          ...prev,
          {
            kind: 'chat',
            role: 'assistant',
            id: event.messageId,
            text: '',
            createdAt: event.createdAt,
            toolExecutions: [],
          },
        ])
        break
      case 'text_delta':
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId && m.role === 'assistant'
              ? { ...m, text: m.text + event.delta }
              : m,
          ),
        )
        break
      case 'thinking_delta':
        // 与 text_delta 同款增量追加,聚到同一条消息的 thinking 字段(A-02)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.messageId && m.role === 'assistant'
              ? { ...m, thinking: (m.thinking ?? '') + event.delta }
              : m,
          ),
        )
        break
      case 'message_end':
        if (streamingMessageIdRef.current === event.messageId) {
          streamingMessageIdRef.current = null
          setStreamingMessageId(null)
        }
        if (event.contextUsage) {
          setContextUsage(event.contextUsage)
        }
        break
      case 'agent_error':
        setStreaming(false)
        streamingMessageIdRef.current = null
        setStreamingMessageId(null)
        setMessages((prev) => [
          ...prev,
          {
            kind: 'error',
            role: 'error',
            id: `error-${Date.now()}`,
            text: event.message,
            createdAt: Date.now(),
            retryable: event.retryable,
          },
        ])
        setLastFailedText(lastUserTextRef.current)
        break
      case 'agent_end': {
        setStreaming(false)
        streamingMessageIdRef.current = null
        setStreamingMessageId(null)
        // 回合结束(正常/abort):该会话挂着 live 的命令不会再有增量,按归属精准回收
        const endedPrefix = `${event.sessionId}#`
        const remaining = new Map(
          [...commandLiveRef.current.entries()].filter(([key]) => !key.startsWith(endedPrefix)),
        )
        if (remaining.size !== commandLiveRef.current.size) {
          commandLiveRef.current = remaining
          setCommandLiveInternal(remaining)
        }
        break
      }
      default:
        break
    }
  }

  /* ============ 会话 CRUD ============ */
  /**
   * 清空当前打开的会话(删除/归档所属角色/归档会话时)。
   * keepDetail=true(归档回看):消息与 detail 保留可翻看,只清审批卡/用量环/流式态;
   * keepDetail=false(删除等):消息、detail 一并清空回空态。
   */
  const clearActiveSession = useCallback((sessionId: string, keepDetail: boolean) => {
    // 归属或展示在这条会话的卡都撤掉(child 文件卡 surface 在 manager 会话,随 manager 会话一起清)
    setAllApprovals((prev) =>
      prev.filter((c) => c.sessionId !== sessionId && c.surfaceSessionId !== sessionId),
    )
    if (agentRunsSessionRef.current === sessionId) {
      agentRunsSessionRef.current = null
      setAgentRuns([])
    }
    if (activeSessionIdRef.current !== sessionId) return
    setContextUsage(null)
    setStreaming(false)
    streamingMessageIdRef.current = null
    setStreamingMessageId(null)
    if (!keepDetail) {
      setMessages([])
      setActiveDetail(null)
      setActiveSessionId(null)
    }
  }, [])

  // 0.5.0:新建会话只传角色；模型由主进程按角色默认解析。
  const createSession = useCallback(
    async (roleId: string) => {
      if (!settingsRef.current || sessionBusy) return
      setSessionBusy(true)
      try {
        const detail = await bridge.invoke('session:create', { roleId })
        setSessions((prev) => [detail.summary, ...prev])
        applyDetail(detail)
        setView('chat')
      } catch (error) {
        showNotice(humanizeError(error))
      } finally {
        setSessionBusy(false)
      }
    },
    [bridge, applyDetail, sessionBusy, showNotice],
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<boolean> => {
      try {
        const summary = await bridge.invoke('session:rename', { sessionId, title })
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? summary : s)))
        setActiveDetail((prev) =>
          prev && prev.summary.id === sessionId ? { ...prev, summary } : prev,
        )
        return true
      } catch (error) {
        showNotice(humanizeError(error))
        return false
      }
    },
    [bridge, showNotice],
  )

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await bridge.invoke('session:delete', { sessionId })
        setSessions((prev) => prev.filter((s) => s.id !== sessionId))
        sessionModelOverridesRef.current.delete(sessionId) // A-24:临时覆盖随会话一起清
        clearActiveSession(sessionId, false)
        showNotice('会话已删除。')
      } catch (error) {
        showNotice(humanizeError(error))
      }
    },
    [bridge, clearActiveSession, showNotice],
  )

  /** 会话归档:列表隐藏;若正打开则保留消息只读回看(顶部归档提示条),只清审批卡/用量环。 */
  const archiveSession = useCallback(
    async (sessionId: string) => {
      try {
        const summary = await bridge.invoke('session:archive', { sessionId })
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? summary : s)))
        clearActiveSession(sessionId, true)
        setActiveDetail((prev) =>
          prev && prev.summary.id === sessionId ? { ...prev, summary } : prev,
        )
        showNotice('会话已归档,在「归档」里可以恢复。')
      } catch (error) {
        // 归档忙碌(ESESSION_BUSY)等:主进程已给出中文人话,直接展示
        showNotice(humanizeError(error))
      }
    },
    [bridge, clearActiveSession, showNotice],
  )

  const restoreSession = useCallback(
    async (sessionId: string) => {
      try {
        const summary = await bridge.invoke('session:restore', { sessionId })
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? summary : s)))
        setActiveDetail((prev) =>
          prev && prev.summary.id === sessionId ? { ...prev, summary } : prev,
        )
        if (summary.roleId !== null) setExpandedRoleId(summary.roleId)
        showNotice('会话已恢复。')
      } catch (error) {
        showNotice(humanizeError(error))
      }
    },
    [bridge, showNotice],
  )

  /* ============ 角色 CRUD(0.2.0;全部以 IPC 返回值更新本地状态) ============ */

  const createRole = useCallback(
    async (input: CreateRoleInput) => {
      try {
        const detail = await bridge.invoke('role:create', input)
        setRoles((prev) => [...prev, detail.summary])
        setExpandedRoleId(detail.summary.id) // 新角色卡上墙并展开;不自动建会话
        setWizardOpen(false)
        showNotice(`「${detail.summary.displayName}」来了,点卡片里的「和他聊聊」开工。`)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: humanizeError(error) }
      }
    },
    [bridge, showNotice],
  )

  const renameRole = useCallback(
    async (roleId: string, displayName: string): Promise<boolean> => {
      try {
        const summary = await bridge.invoke('role:update', { roleId, displayName })
        setRoles((prev) => prev.map((r) => (r.id === roleId ? summary : r)))
        setRulesDetail((prev) =>
          prev && prev.summary.id === roleId ? { ...prev, summary } : prev,
        )
        return true
      } catch (error) {
        showNotice(humanizeError(error))
        return false
      }
    },
    [bridge, showNotice],
  )

  const archiveRole = useCallback(
    async (roleId: string) => {
      try {
        const summary = await bridge.invoke('role:archive', { roleId })
        setRoles((prev) => prev.map((r) => (r.id === roleId ? summary : r)))
        // 当前打开的会话属于被归档角色:整卡从主列表消失,聊天区清空回空态
        const active = activeSessionIdRef.current
        const activeRoleId = active
          ? sessionsRef.current.find((s) => s.id === active)?.roleId
          : undefined
        if (active && activeRoleId === roleId) clearActiveSession(active, false)
        if (expandedRoleId === roleId) setExpandedRoleId(null)
        showNotice('角色已归档,在「归档」里可以恢复。')
      } catch (error) {
        // 归档忙碌(ESESSION_BUSY)等:主进程已给出中文人话,直接展示
        showNotice(humanizeError(error))
      }
    },
    [bridge, clearActiveSession, expandedRoleId, showNotice],
  )

  const restoreRole = useCallback(
    async (roleId: string) => {
      try {
        const summary = await bridge.invoke('role:restore', { roleId })
        setRoles((prev) => prev.map((r) => (r.id === roleId ? summary : r)))
        showNotice('角色已恢复。')
      } catch (error) {
        showNotice(humanizeError(error))
      }
    },
    [bridge, showNotice],
  )

  const getDeleteImpact = useCallback(
    (roleId: string) => bridge.invoke('role:getDeleteImpact', { roleId }),
    [bridge],
  )

  const deleteRole = useCallback(
    async (
      roleId: string,
      confirmDisplayName: string,
      impactVersion: string,
    ): Promise<DeleteRoleResult> => {
      try {
        const result = await bridge.invoke('role:delete', {
          roleId,
          confirmDisplayName,
          impactVersion,
          deleteSessions: true,
        })
        const deletedIds = new Set(result.deletedSessionIds)
        setRoles((prev) => prev.filter((r) => r.id !== roleId))
        setSessions((prev) => prev.filter((s) => !deletedIds.has(s.id)))
        // A-24(PLAN §2.1-7):角色删除成功,在同一 settings 串行链清掉它的默认模型映射
        // (主进程另有孤儿剪枝兜底);被删会话的临时覆盖一并清
        for (const id of deletedIds) sessionModelOverridesRef.current.delete(id)
        void enqueueSettingsMutation((current) => withRoleModelDefault(current, roleId, null), {
          silent: true,
        })
        setAllApprovals((prev) =>
          prev.filter(
            (c) => !deletedIds.has(c.sessionId) && !deletedIds.has(c.surfaceSessionId),
          ),
        )
        // 当前页/会话属于被删角色:回空 chat
        const active = activeSessionIdRef.current
        if (active !== null && deletedIds.has(active)) {
          setActiveDetail(null)
          setActiveSessionId(null)
          setMessages([])
          setContextUsage(null)
          setStreaming(false)
          streamingMessageIdRef.current = null
          setStreamingMessageId(null)
        }
        if (rulesRoleId === roleId) {
          setRulesRoleId(null)
          setRulesDetail(null)
        }
        setDeleteDialogRole(null)
        setView('chat')
        showNotice('角色已删除;使用统计保留。')
        return { ok: true, result }
      } catch (error) {
        const message = humanizeError(error)
        if (isDeleteIncomplete(error)) {
          // 删除未完成:角色已落 delete_failed,立刻重拉列表让 lifecycle 标记生效(不等下次启动)
          try {
            const fresh = await bridge.invoke('role:list', undefined)
            setRoles([...fresh])
          } catch {
            // 刷新失败只保留旧数据,下次启动/操作再校准;原错误照常返回
          }
        }
        return { ok: false, message, stale: isImpactStale(error) }
      }
    },
    [bridge, rulesRoleId, showNotice, enqueueSettingsMutation],
  )

  /* ---- 守则编辑页 ---- */
  /**
   * 打开守则编辑页;prefillGuardrails(批 2b 草稿卡「过目并保存」)只做本地预填,
   * 由 RoleRulesView 填进编辑框——用户亲手点保存才发 role:updateGuardrails,AI 不落笔。
   */
  const openRoleRules = useCallback(
    async (roleId: string, prefillGuardrails?: string) => {
      setRulesRoleId(roleId)
      setRulesDetail(null)
      setRulesPrefill(prefillGuardrails ?? null)
      setRulesLoading(true)
      setView('role-rules')
      try {
        const detail = await bridge.invoke('role:get', { roleId })
        setRulesDetail(detail)
      } catch (error) {
        showNotice(humanizeError(error))
        setRulesRoleId(null)
        setRulesPrefill(null)
        setView('chat')
      } finally {
        setRulesLoading(false)
      }
    },
    [bridge, showNotice],
  )

  const saveGuardrails = useCallback(
    async (guardrails: string): Promise<SaveGuardrailsResult> => {
      const current = rulesDetail
      if (!current) return 'error'
      try {
        const detail = await bridge.invoke('role:updateGuardrails', {
          roleId: current.summary.id,
          guardrails,
          expectedVersion: current.guardrailsVersion,
        })
        setRulesDetail(detail)
        setRoles((prev) => prev.map((r) => (r.id === detail.summary.id ? detail.summary : r)))
        showNotice('守则已更新,从下一条消息开始生效。')
        return 'saved'
      } catch (error) {
        const message = humanizeError(error)
        if (isGuardrailsConflict(error)) {
          // expectedVersion 失效:先提示再重拉覆盖(不静默吞掉用户输入的区别在提示)
          showNotice(message)
          try {
            const fresh = await bridge.invoke('role:get', { roleId: current.summary.id })
            setRulesDetail(fresh)
          } catch {
            /* 重拉失败则保留现状,用户可手动返回再进 */
          }
          return 'conflict'
        }
        showNotice(message)
        return 'error'
      }
    },
    [bridge, rulesDetail, showNotice],
  )

  const closeRoleRules = useCallback(() => {
    setRulesRoleId(null)
    setRulesDetail(null)
    setRulesPrefill(null)
    setView('chat')
  }, [])

  /* ============ 消息 ============ */
  // 草稿读写(A-12):空串即清槽,读取缺省 ''。切换会话无需特判——受控组件按当前 sessionId 取槽。
  const draftFor = useCallback(
    (sessionId: string | null): string =>
      sessionId === null ? '' : (drafts.get(sessionId) ?? ''),
    [drafts],
  )
  const setDraft = useCallback((sessionId: string | null, text: string) => {
    if (sessionId === null) return
    setDrafts((prev) => {
      if (text === '') {
        if (!prev.has(sessionId)) return prev
        const next = new Map(prev)
        next.delete(sessionId)
        return next
      }
      const next = new Map(prev)
      next.set(sessionId, text)
      return next
    })
  }, [])

  const send = useCallback(
    async (text: string) => {
      const sessionId = activeSessionIdRef.current
      const trimmed = text.trim()
      // 已归档会话只读回看:输入框已禁用,这里再拦一道(后端也会拒)
      if (activeDetailRef.current?.summary.archivedAt != null) return
      if (!sessionId || trimmed === '' || streaming || sending) return
      setSending(true)
      setChatError(null)
      try {
        // A-24:发送用当前会话生效选择(临时覆盖 > 角色默认 > 全局默认),不再直读全局值
        const selection = activeModelSelectionRef.current ?? settingsRef.current?.providerSelection
        if (!selection) return
        const userMessage = await bridge.invoke('message:send', { sessionId, text: trimmed, selection })
        lastUserTextRef.current = trimmed
        setLastFailedText(null)
        setMessages((prev) => [...prev, userMessage])
        setStreaming(true)
      } catch (error) {
        setChatError(humanizeError(error))
        setLastFailedText(trimmed)
        lastUserTextRef.current = trimmed
      } finally {
        setSending(false)
      }
    },
    [bridge, streaming, sending],
  )

  const abort = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    try {
      await bridge.invoke('message:abort', { sessionId })
    } catch (error) {
      setChatError(humanizeError(error))
    }
  }, [bridge])

  const retryLast = useCallback(async () => {
    const text = lastUserTextRef.current
    if (!text) return
    // 清掉上一条错误消息再重发。
    setMessages((prev) => prev.filter((m) => m.role !== 'error'))
    setLastFailedText(null)
    await send(text)
  }, [send])

  /* ============ 确认卡片 ============ */
  const respondApproval = useCallback(
    async (card: ApprovalCardState, decision: ApprovalDecision, note: string, selectedOptionId?: string) => {
      if (card.responded) return // 重复点击只发送一次
      const trimmedNote = note.trim()
      setAllApprovals((prev) =>
        prev.map((c) =>
          c.request.id === card.request.id
            ? {
                ...c,
                responded: true,
                decision,
                ...(trimmedNote !== '' ? { note: trimmedNote } : {}),
              }
            : c,
        ),
      )
      try {
        await bridge.invoke('approval:respond', {
          approvalId: card.request.id,
          decision,
          // selectedOptionId 只在 skill-candidate 批准时携带(契约语义校验位在 schemas.ts)
          ...(selectedOptionId !== undefined ? { selectedOptionId } : {}),
          ...(decision === 'reject' && trimmedNote !== '' ? { note: trimmedNote } : {}),
        })
      } catch (error) {
        // 发送失败允许再点一次。
        setAllApprovals((prev) =>
          prev.map((c) =>
            c.request.id === card.request.id
              ? { ...c, responded: false, error: humanizeError(error) }
              : c,
          ),
        )
      }
    },
    [bridge],
  )

  /* ============ 派活卡(0.3.0) ============ */
  /**
   * 派活确认响应:approve=同意派出 / reject=不派,按 approvalId 走 approval:respond。
   * 重复点击只发一次;发送失败允许再点一次。
   */
  const respondDelegation = useCallback(
    (request: DelegationApprovalRequest, decision: 'approve' | 'reject') => {
      const entry = delegationRequests.get(request.runId)
      if (entry === undefined || entry.responded) return
      setDelegationRequests((prev) => {
        const current = prev.get(request.runId)
        if (current === undefined || current.responded) return prev
        return new Map(prev).set(request.runId, { ...current, responded: true })
      })
      void bridge
        .invoke('approval:respond', { approvalId: request.id, decision })
        .catch((error: unknown) => {
          // 失败回退只允许「翻回本次尝试的条目」:条目被更新的请求替换过、
          // 或已决回执先到了,都不动——不把已 responded=true 的条目覆盖回 false 复活成可点
          setDelegationRequests((prev) => {
            const current = prev.get(request.runId)
            if (current === undefined || current.request.id !== request.id) return prev
            return new Map(prev).set(request.runId, { ...current, responded: false })
          })
          showNotice(humanizeError(error))
        })
    },
    [bridge, delegationRequests, showNotice],
  )

  /**
   * 受控打断(0.4.0 D):非终态才发;成功后本地原位翻状态(等 agent_run_updated 校正
 * 也以本地这版打底),失败错误码已是中文人话,直接 notice 出示。
   */
  const interruptRun = useCallback(
    async (runId: string) => {
      const managerSessionId = agentRunsSessionRef.current
      const run = agentRunsRef.current.find((r) => r.runId === runId)
      if (managerSessionId === null || run === undefined) return
      if (
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'rejected' ||
        run.status === 'interrupted' ||
        interruptBusyRef.current.has(runId)
      ) {
        return
      }
      const nextBusy = new Set(interruptBusyRef.current)
      nextBusy.add(runId)
      interruptBusyRef.current = nextBusy
      setInterruptBusy(nextBusy)
      try {
        const updated = await bridge.invoke('agentRun:interrupt', { runId, managerSessionId })
        if (updated.managerSessionId !== agentRunsSessionRef.current) return
        setAgentRuns((prev) => {
          const index = prev.findIndex((r) => r.runId === updated.runId)
          if (index < 0) return prev // 列表已换会话/条目刚被清:不塞回孤儿
          const next = [...prev]
          next[index] = updated
          return next
        })
        showNotice('打断成功:干完的部分都留着。')
      } catch (error) {
        showNotice(`没能打断:${humanizeError(error)}`)
      } finally {
        const rest = new Set(interruptBusyRef.current)
        rest.delete(runId)
        interruptBusyRef.current = rest
        setInterruptBusy(rest)
      }
    },
    [bridge, showNotice],
  )

  /**
   * 派活卡「查看完整过程」(A-28 收编,PLAN §6.2 规则 3/§6.3):不再切整页,
   * 显式 pin 该卡所属链+run tab,展开面板详情态;多节点链顺带拉图(handoff 边)。
   * run 找不到(列表已换会话等)就不动,避免悬空详情。
   */
  const openAgentRunDetail = useCallback(
    (runId: string) => {
      const run = agentRunsRef.current.find((r) => r.runId === runId)
      if (run === undefined) return
      setPanelPinned({ graphId: run.graphId, runId })
      setPanelSelectedRunId(runId)
      setPanelDetailOpen(true)
      setPanelMinimized(false)
      ensureGraphForRun(run)
      ensureRunDetailFresh(runId)
    },
    [ensureGraphForRun, ensureRunDetailFresh],
  )

  /* ---- 面板动作(A-28):展开/收起/详情/tab;全部走上面的 ref+state 双写 ---- */
  const panelExpand = useCallback(() => {
    setPanelMinimized(false)
    // 小窗态展开图标=手动档:全终态空闲链也要点得开面板(线框图三态互达)
    setPanelManualExpanded(true)
  }, [])
  const panelMinimize = useCallback(() => {
    setPanelMinimized(true)
    setPanelManualExpanded(false)
    // 收起面板时详情态一起收(三态互斥,mini 不叠 detail)
    setPanelDetailOpen(false)
  }, [])
  const panelCloseDetail = useCallback(() => setPanelDetailOpen(false), [])
  const panelSelectRun = useCallback(
    (runId: string) => {
      setPanelSelectedRunId(runId)
      // pin 的语义=这条链+这个 tab(规则 3):链内切 tab 时 pin 的 tab 跟上,链 pin 不动
      const pinned = panelPinnedRef.current
      if (pinned !== null) setPanelPinned({ graphId: pinned.graphId, runId })
      if (panelDetailOpenRef.current) ensureRunDetailFresh(runId)
    },
    [ensureRunDetailFresh],
  )
  const panelOpenDetail = useCallback(
    (runId?: string) => {
      if (runId !== undefined) {
        setPanelSelectedRunId(runId)
        const pinned = panelPinnedRef.current
        if (pinned !== null) setPanelPinned({ graphId: pinned.graphId, runId })
      }
      setPanelDetailOpen(true)
      setPanelMinimized(false)
      // 打开即取选中 tab 的详情(首次/标脏才发请求)。
      // ⑦审整改:显式传入 runId 时直接用它——setPanelSelectedRunId 落 state 是异步的,
      // resolvePanelSelection 读 ref 会拿到旧 tab,首次点节点可能拉错 run 的详情
      const selected = runId ?? resolvePanelSelection().runId
      if (selected !== null) ensureRunDetailFresh(selected)
    },
    [resolvePanelSelection, ensureRunDetailFresh],
  )

  /** 传给 DelegationCard 的稳定动作合集;数据面(map/set)变化时才换新引用。 */
  const delegation: DelegationCardActions = useMemo(
    () => ({
      approvalFor: (runId) => delegationRequests.get(runId),
      detailFor: (runId) => runDetails.get(runId),
      detailLoadingFor: (runId) => runDetailLoading.has(runId),
      onLoadDetail: loadRunDetail,
      onOpenFullDetail: openAgentRunDetail,
      onRespond: respondDelegation,
      // 协作链(0.4.0 D):卡头链摘要/浮层的数据源(本地 agentRuns 派生,不发 IPC)
      chainPeersFor: (graphId) =>
        [...agentRuns]
          .filter((r) => r.graphId === graphId)
          .sort((a, b) => a.createdAt - b.createdAt),
      interruptBusyFor: (runId) => interruptBusy.has(runId),
      onInterrupt: (runId) => {
        void interruptRun(runId)
      },
    }),
    [
      delegationRequests,
      runDetails,
      runDetailLoading,
      loadRunDetail,
      openAgentRunDetail,
      respondDelegation,
      agentRuns,
      interruptBusy,
      interruptRun,
    ],
  )

  /* ============ 设置与凭据 ============ */

  const selectProvider = useCallback(
    (selection: ProviderSelection) =>
      enqueueSettingsMutation((current) => withProviderSelection(current, selection)),
    [enqueueSettingsMutation],
  )

  /**
   * 会话内临时切换(A-24,聊天区右下角):只写内存覆盖,不落盘、不动角色默认。
   * 选回与默认相同即清覆盖——会话重新跟随角色默认/全局。
   */
  const selectSessionProvider = useCallback((selection: ProviderSelection) => {
    const sessionId = activeSessionIdRef.current
    if (sessionId === null) return
    const roleId = activeDetailRef.current?.summary.roleId ?? null
    const current = settingsChain.current.latest ?? settingsRef.current
    const resolvedDefault =
      current === null
        ? null
        : roleId === null
          ? current.providerSelection
          : resolveRoleModel(current, roleId).selection
    if (resolvedDefault !== null && sameModel(resolvedDefault, selection)) {
      sessionModelOverridesRef.current.delete(sessionId)
    } else {
      sessionModelOverridesRef.current.set(sessionId, selection)
    }
    setActiveModelSelection(selection)
  }, [])

  /**
   * 「存为该角色默认」(A-24):当前会话属角色且选择在启用池才写;
   * 写入走 settings 串行链,成功后清掉本会话临时覆盖(默认已等于当前选择,覆盖失去意义)。
   */
  const saveActiveModelAsRoleDefault = useCallback(async (): Promise<void> => {
    const roleId = activeDetailRef.current?.summary.roleId ?? null
    const selection = activeModelSelectionRef.current
    const sessionId = activeSessionIdRef.current
    const current = settingsChain.current.latest ?? settingsRef.current
    if (roleId === null || selection === null || current === null) return
    if (!(current.enabledModels?.some((m) => sameModel(m, selection)) ?? false)) {
      showNotice('当前模型不在常用池,先到设置页勾选入池再存。')
      return
    }
    const ok = await enqueueSettingsMutation((latest) => withRoleModelDefault(latest, roleId, selection))
    // ⑤审整改:失败时错误提示已由串行链弹出,此处不清临时覆盖、不弹成功,避免误报
    if (!ok) return
    if (sessionId !== null) sessionModelOverridesRef.current.delete(sessionId)
    showNotice('已存为该角色的默认模型,以后它的新会话都用这个。')
  }, [enqueueSettingsMutation, showNotice])

  /** 设置页角色默认模型面板的写入入口(A-24):selection=null 即「跟随全局」(删映射)。 */
  const setRoleModelDefault = useCallback(
    (roleId: string, selection: ProviderSelection | null) =>
      enqueueSettingsMutation((current) => withRoleModelDefault(current, roleId, selection)),
    [enqueueSettingsMutation],
  )

  /** 思考强度:把现有 settings 原样加上 thinkingLevel 整体保存,下一条消息生效。 */
  const updateThinkingLevel = useCallback(
    (level: ThinkingLevel) =>
      enqueueSettingsMutation((current) => ({ ...current, thinkingLevel: level })),
    [enqueueSettingsMutation],
  )

  /**
   * 启用池勾选(设置页模型清单):换掉 enabledModels 整体保存;
   * 池满被纯函数拒绝时原样返回引用相等,链内直接跳过不发徒劳 IPC;保存失败回滚。
   * ⑦审整改(REQUIREMENT §12.1"移出池回退全局默认**并提示**"):
   * 移出池会让主进程剪掉引用该模型的角色默认映射——保存成功后对比前后差异,受影响角色弹提示。
   */
  const toggleEnabledModel = useCallback(
    async (item: ProviderSelection): Promise<boolean> => {
      const before = settingsChain.current.latest ?? settingsRef.current
      const beforeDefaults = before?.roleModelDefaults ?? {}
      const ok = await enqueueSettingsMutation((current) => toggleEnabledModelInSettings(current, item))
      if (!ok) return false
      const after = settingsChain.current.latest?.roleModelDefaults ?? {}
      const affected = Object.entries(beforeDefaults).filter(
        ([roleId, sel]) => sameModel(sel, item) && after[roleId] === undefined,
      )
      if (affected.length > 0) {
        const names = affected.map(([roleId]) => {
          if (roleId === 'sys-xiaozhen') return '小柊'
          const name = rolesRef.current.find((r) => r.id === roleId)?.displayName
          return name ?? '某角色'
        })
        showNotice(`「${names.join('」「')}」的默认模型已移出常用池,回退为全局默认;可在设置页重新指定。`)
      }
      return true
    },
    [enqueueSettingsMutation, showNotice],
  )

  const saveCredential = useCallback(
    async (providerId: ProviderId, apiKey: string): Promise<boolean> => {
      const status = await bridge.invoke('credential:save', { providerId, apiKey })
      setCredentials((prev) => prev.map((c) => (c.providerId === providerId ? status : c)))
      return true
    },
    [bridge],
  )

  const deleteCredential = useCallback(
    async (providerId: ProviderId) => {
      const status = await bridge.invoke('credential:delete', { providerId })
      setCredentials((prev) => prev.map((c) => (c.providerId === providerId ? status : c)))
    },
    [bridge],
  )

  const testCredential = useCallback(
    (providerId: ProviderId) => bridge.invoke('credential:test', { providerId }),
    [bridge],
  )

  /* ---- 新建角色向导(批 2b 起支持草稿预填:只预填,不替用户确认) ---- */
  const openWizard = useCallback(
    (prefill?: { readonly displayName: string; readonly guardrails: string }) => {
      // 防御:onClick={openWizard} 这类直连会把 MouseEvent 当 prefill 漏进来,只认草稿形状
      const clean =
        prefill != null &&
        typeof prefill.displayName === 'string' &&
        typeof prefill.guardrails === 'string'
          ? prefill
          : null
      setWizardPrefill(clean)
      setWizardOpen(true)
    },
    [],
  )
  const closeWizard = useCallback(() => {
    setWizardOpen(false)
    setWizardPrefill(null)
  }, [])

  /* ============ 提醒 ============ */
  const dismissReminder = useCallback((memoryId: string) => {
    setDismissedReminders((prev) => [...prev, memoryId])
  }, [])

  const visibleReminders = reminders.filter((r) => !dismissedReminders.includes(r.memoryId))

  /** 当前会话可见的确认卡:按展示会话(surface)过滤——child 文件卡浮在小柊会话,响应仍按 approvalId 回主进程(PLAN §10.4)。 */
  const approvals = allApprovals.filter((c) => c.surfaceSessionId === activeSessionId)

  // A-13:AI 名字跟角色走——会话换了角色,气泡名与空态文案立刻跟着换
  const activeRoleName = resolveActiveRoleName(roles, activeDetail)

  /**
   * 协作链面板数据(A-28,PLAN §6.2/§6.4):
   * - 当前链:resolvePanelGraphId(五规则:pin 优先 → 非终态最新 → 全终态最近);
   * - graph 合成:节点=agentRuns 活体(推送原位实时),边=getGraph 缓存
   *   (未取回先用依赖边,handoff 边随后补齐),汇总数字本地算(口径同主进程);
   * - 选中 tab:resolveSelectedRunId 回退(节点增删后落到最近更新的一条);
   * - 无 run/非 manager 会话:graph=null,面板整体不渲染。
   */
  const collabPanel = useMemo<CollabPanelData>(() => {
    // ⑤审整改:详情态正在看的链不参与"新链 push 自动切换"——
    // panelPinned(显式钉住)优先;其次详情态沿用正在显示的链;否则走自动规则。
    const stickyGraphId =
      panelPinned?.graphId ?? (panelDetailOpen ? panelShownGraphIdRef.current : null)
    const graphId = resolvePanelGraphId(agentRuns, stickyGraphId)
    if (graphId !== null) panelShownGraphIdRef.current = graphId
    if (graphId === null) {
      return {
        graph: null,
        graphLoading: false,
        minimized: panelMinimized,
        manualExpanded: panelManualExpanded,
        detailOpen: panelDetailOpen,
        selectedRunId: null,
        selectedDetail: undefined,
        selectedDetailLoading: false,
        pinned: panelPinned !== null,
      }
    }
    const nodes = agentRuns.filter((r) => r.graphId === graphId)
    const graph = composePanelGraph(
      graphId,
      nodes[0]?.managerSessionId ?? '',
      nodes,
      agentGraphs.get(graphId),
    )
    const selectedRunId = resolveSelectedRunId(graph.nodes, panelSelectedRunId)
    return {
      graph,
      graphLoading: graphLoadingIds.has(graphId),
      minimized: panelMinimized,
      manualExpanded: panelManualExpanded,
      detailOpen: panelDetailOpen,
      selectedRunId,
      selectedDetail: selectedRunId !== null ? runDetails.get(selectedRunId) : undefined,
      selectedDetailLoading: selectedRunId !== null && runDetailLoading.has(selectedRunId),
      pinned: panelPinned !== null && panelPinned.graphId === graphId,
    }
  }, [
    agentRuns,
    panelPinned,
    panelMinimized,
    panelManualExpanded,
    panelDetailOpen,
    panelSelectedRunId,
    agentGraphs,
    graphLoadingIds,
    runDetails,
    runDetailLoading,
  ])

  // 面板显示的链是多节点 → 拉图补 handoff 边(单节点链本地合成已够,不发 IPC)
  const panelGraphId = collabPanel.graph?.graphId ?? null
  useEffect(() => {
    if (panelGraphId === null) return
    const peers = agentRuns.filter((r) => r.graphId === panelGraphId)
    if (peers.length > 1) loadAgentGraph(panelGraphId)
  }, [panelGraphId, agentRuns, loadAgentGraph])

  const collabPanelActions = useMemo<CollabPanelActions>(
    () => ({
      expand: panelExpand,
      minimize: panelMinimize,
      openDetail: panelOpenDetail,
      closeDetail: panelCloseDetail,
      selectRun: panelSelectRun,
    }),
    [panelExpand, panelMinimize, panelOpenDetail, panelCloseDetail, panelSelectRun],
  )

  return {
    bootstrap,
    bootstrapError,
    retryBootstrap: () => void bootstrapOnce(),
    view,
    openSettings: () => setView('settings'),
    closeSettings: () => setView('chat'),
    openUsage: () => setView('usage'), // 打开统计不清当前会话、不打断后台回复
    closeUsage: () => setView('chat'),
    closeArchive: () => setView('chat'),
    sessions,
    activeSessionId,
    activeDetail,
    activeRoleName,
    detailLoading,
    createSession,
    openSession,
    renameSession,
    deleteSession,
    archiveSession,
    restoreSession,
    sessionBusy,
    notice,
    roles,
    expandedRoleId,
    setExpandedRoleId,
    wizardOpen,
    wizardPrefill,
    openWizard,
    closeWizard,
    createRole,
    renameRole,
    archiveRole,
    restoreRole,
    getDeleteImpact,
    deleteRole,
    deleteDialogRole,
    openDeleteDialog: (role: RoleSummary) => setDeleteDialogRole(role),
    closeDeleteDialog: () => setDeleteDialogRole(null),
    rulesRoleId,
    rulesDetail,
    rulesLoading,
    rulesPrefill,
    openRoleRules,
    closeRoleRules,
    saveGuardrails,
    openArchive: () => setView('archive'),
    messages,
    streaming,
    streamingMessageId,
    sending,
    chatError,
    contextUsage,
    draftFor,
    setDraft,
    updateState,
    checkUpdate: async () => {
      await bridge.invoke('app:checkUpdate', undefined)
    },
    downloadUpdate: async () => {
      await bridge.invoke('update:download', undefined)
    },
    installUpdate: () => {
      void bridge.invoke('update:install', undefined)
    },
    send,
    abort,
    retryLast,
    lastFailedText,
    approvals,
    commandLive,
    respondApproval,
    agentRuns,
    delegation,
    collabPanel,
    collabPanelActions,
    interruptRun,
    settings,
    selectProvider,
    activeModelSelection,
    selectSessionProvider,
    saveActiveModelAsRoleDefault,
    setRoleModelDefault,
    toggleEnabledModel,
    updateThinkingLevel,
    credentials,
    saveCredential,
    deleteCredential,
    testCredential,
    reminders: visibleReminders,
    dismissReminder,
  }
}
