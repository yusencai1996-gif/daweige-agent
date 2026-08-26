import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentRunDetail,
  AgentRunSummary,
  ApprovalDecision,
  DelegationApprovalRequest,
  FileApprovalRequest,
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
import { isIpcErrorPayload, type IpcErrorCode } from '../../shared/ipc/errors'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { DaweigeBridge } from '../../shared/ipc/bridge'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import { resolveActiveRoleName } from './active-role-name'
import { withProviderSelection } from '../features/settings/model-options'
import type { DelegationCardActions } from '../features/manager/DelegationCard'

/** 确认卡片阶段:pending(等用户)→ running(执行中…)→ succeeded/rejected/failed。 */
export type ApprovalPhase = 'pending' | 'running' | 'succeeded' | 'rejected' | 'failed'

export interface ApprovalCardState {
  /** 归属会话(授权/响应按它走;切换会话再切回,等待中的卡片不丢)。 */
  readonly sessionId: string
  /** 展示会话(0.3.0,PLAN §10.4):child 的文件卡 sessionId=internal,surfaceSessionId=manager 用户会话;普通会话与 sessionId 相同。 */
  readonly surfaceSessionId: string
  /** 文件/守则卡;delegation(0.3.0)不入此列表(由派活卡渲染)。 */
  readonly request: FileApprovalRequest
  readonly phase: ApprovalPhase
  /** 已发过 approval:respond(重复点击只发送一次的守卫)。 */
  readonly responded: boolean
  readonly decision?: ApprovalDecision
  /** 拒绝时的附言(用于结果态回显)。 */
  readonly note?: string
  readonly error?: string
}

export type ViewMode = 'chat' | 'role-rules' | 'archive' | 'usage' | 'settings' | 'agent-run-detail'

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
  readonly respondApproval: (
    card: ApprovalCardState,
    decision: ApprovalDecision,
    note: string,
  ) => Promise<void>
  // 派活卡(0.3.0,PLAN §10.2):当前打开的 manager 用户会话名下的 run 列表(其他会话恒空)
  readonly agentRuns: readonly AgentRunSummary[]
  /** 派活卡动作合集(确认响应/详情懒加载),稳定引用,直接透传到 DelegationCard。 */
  readonly delegation: DelegationCardActions
  /**
   * internal 只读详情整页(批 2b,PLAN §10.3):非 null 即 ViewMode='agent-run-detail'。
   * run 优先取列表里的活体(状态实时),列表里找不到(角色被删等)退回打开时的快照。
   */
  readonly runDetailView: {
    readonly run: AgentRunSummary
    readonly detail: AgentRunDetail | undefined
    readonly loading: boolean
  } | null
  readonly openAgentRunDetail: (runId: string) => void
  readonly closeAgentRunDetail: () => void
  // 设置与凭据
  readonly settings: Settings | null
  readonly selectProvider: (selection: ProviderSelection) => Promise<void>
  readonly updateThinkingLevel: (level: ThinkingLevel) => Promise<void>
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

  /* ---- 派活卡(0.3.0) ---- */
  /** 当前打开的 manager 用户会话名下的 run;切到普通会话即清空(只在 manager 会话打开时拉)。 */
  const [agentRuns, setAgentRuns] = useState<readonly AgentRunSummary[]>([])
  /** delegation 确认请求,按 runId 索引;awaiting 派活卡的确认内容/响应入口。 */
  const [delegationRequests, setDelegationRequests] = useState<
    ReadonlyMap<string, { readonly request: DelegationApprovalRequest; readonly responded: boolean }>
  >(new Map())
  /** 已取回的派活详情(结论摘要/展开细节/完整过程共用一份缓存)。 */
  const [runDetails, setRunDetails] = useState<ReadonlyMap<string, AgentRunDetail>>(new Map())
  const [runDetailLoading, setRunDetailLoading] = useState<ReadonlySet<string>>(new Set())

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

  /* ---- 守则草稿预填(批 2b,PLAN §10.5) ---- */
  /** 「用这个草稿建角色」带进向导的预填;普通「新建角色」为 null。 */
  const [wizardPrefill, setWizardPrefill] = useState<{
    readonly displayName: string
    readonly guardrails: string
  } | null>(null)
  /** 「过目并保存」带进守则编辑页的预填正文;普通「编辑守则」为 null。 */
  const [rulesPrefill, setRulesPrefill] = useState<string | null>(null)

  /* ---- internal 只读详情整页(批 2b,PLAN §10.3) ---- */
  /** 非 null 即 ViewMode='agent-run-detail';snapshot 兜底列表里找不到的 run(角色被删等)。 */
  const [runDetailOpen, setRunDetailOpen] = useState<{
    readonly runId: string
    readonly snapshot: AgentRunSummary
  } | null>(null)
  /** 事件回调里判断「详情页正开着哪个 run」(agent_run_updated → 重拉完整过程;internal 事件 → 防抖同步)。 */
  const runDetailOpenRef = useRef<{
    readonly runId: string
    readonly snapshot: AgentRunSummary
  } | null>(null)
  runDetailOpenRef.current = runDetailOpen
  /**
   * 严重-2(0.3.0 整改):详情页打开时 child(internal)干活事件的防抖同步计时器。
   * 非 null 表示 500ms 窗口内已挂起一次重拉,窗口内后续事件合并掉(最多每 500ms 拉一次)。
   */
  const runDetailSyncTimerRef = useRef<number | null>(null)
  /** usage_updated 防抖计时器(初审-严重,PLAN §9.2):200ms 窗口合并成一次重拉。 */
  const usageSyncTimerRef = useRef<number | null>(null)

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3200)
  }, [])

  const applyDetail = useCallback(
    (detail: SessionDetail) => {
      setActiveDetail(detail)
      setActiveSessionId(detail.summary.id)
      setMessages(detail.messages)
      setStreaming(false)
      setChatError(null)
      setLastFailedText(null)
      setContextUsage(null) // 切换会话时清空用量环
      streamingMessageIdRef.current = null
      setStreamingMessageId(null)
      // 详情整页(批 2b)属于上一条 manager 会话:切会话即关掉,不留旧 run 悬在空中
      setRunDetailOpen(null)
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
    [bridge],
  )

  const openSession = useCallback(
    async (sessionId: string) => {
      setDetailLoading(true)
      setChatError(null)
      try {
        const detail = await bridge.invoke('session:open', { sessionId })
        applyDetail(detail)
        setView('chat') // 点会话切回聊天(从使用统计/设置页回来时)
        // 记住上次活跃会话(尽力而为,不阻断打开)。
        const current = settingsRef.current
        if (current) {
          const next: Settings = { ...current, lastActiveSessionId: sessionId }
          setSettings(next)
          bridge.invoke('settings:update', { settings: next }).catch(() => undefined)
        }
      } catch (error) {
        setChatError(humanizeError(error))
      } finally {
        setDetailLoading(false)
      }
    },
    [bridge, applyDetail],
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
   * 派活详情拉取(结论摘要/展开细节/查看完整过程/详情页实时刷新共用);
   * 加载中的重复调用直接跳过(同步守卫,StrictMode 双跑也只发一次)。
   * 放在事件流之前定义:agent_run_updated 里要复用它刷新详情整页(批 2b)。
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
        .invoke('agentRun:getDetail', { runId })
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

  /* ============ agent 事件流 ============ */
  /**
   * 严重-2(0.3.0 整改,PLAN §7.2/§10.3):详情整页打开时,child 的 internal 会话事件
   * (text_delta/thinking_delta/message_end/tool_start/tool_end 等)轻量路由到这里——
   * 短防抖后重拉 agentRun:getDetail,以主进程快照为准(renderer 不手拼流式 delta,
   * 不会与 pi 持久化竞态)。500ms 窗口内事件合并成一次;详情页关闭/切走会话即停(触发时校验)。
   */
  const scheduleRunDetailSync = useCallback(
    (runId: string) => {
      if (runDetailSyncTimerRef.current !== null) return
      runDetailSyncTimerRef.current = window.setTimeout(() => {
        runDetailSyncTimerRef.current = null
        if (runDetailOpenRef.current?.runId !== runId) return
        loadRunDetail(runId)
      }, 500)
    },
    [loadRunDetail],
  )

  /**
   * 初审-严重(0.3.0 追加整改,PLAN §9.2):usage_updated 防抖 200ms 重拉。
   * usage 落库可能晚于终态 agent_run_updated——不重拉的话 completed 派活卡会永远停在
   * 「轮次 0 · 总 token 0」。只在 manager 会话 run 列表已加载时重拉列表(失败静默);
   * 详情整页开着就同时重拉 getDetail。
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
      const openRunId = runDetailOpenRef.current?.runId ?? null
      if (openRunId !== null) loadRunDetail(openRunId)
    }, 200)
  }, [bridge, loadRunDetail])

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
      // 派活状态变化(0.3.0):upsert 进当前 manager 会话的 run 列表,卡片原位变状态(PLAN §10.2)
      if (event.type === 'agent_run_updated') {
        const run = event.run
        if (run.managerSessionId === agentRunsSessionRef.current) {
          setAgentRuns((prev) => {
            const index = prev.findIndex((r) => r.runId === run.runId)
            if (index < 0) return [...prev, run]
            const next = [...prev]
            next[index] = run
            return next
          })
        }
        // 详情整页正开着这条 run(running/waiting 实时刷新,批 2b PLAN §10.3):
        // 重拉 getDetail 恢复完整历史;loadRunDetail 自带加载中去重
        if (runDetailOpenRef.current?.runId === run.runId) loadRunDetail(run.runId)
        return
      }
      // 严重-2(0.3.0 整改):详情整页打开期间,child internal 会话的干活事件
      // 防抖 500ms 重拉详情——运行中打开「查看完整过程」能看到过程持续推进。
      // internalSessionId 优先取列表活体(批准后才挂上),兜底打开时的快照。
      if (
        event.type === 'message_start' ||
        event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'message_end' ||
        event.type === 'tool_start' ||
        event.type === 'tool_end'
      ) {
        const openRun = runDetailOpenRef.current
        if (openRun !== null) {
          const internalSessionId =
            agentRunsRef.current.find((r) => r.runId === openRun.runId)?.internalSessionId ??
            openRun.snapshot.internalSessionId
          if (internalSessionId !== null && event.sessionId === internalSessionId) {
            scheduleRunDetailSync(openRun.runId)
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
          // 非当前会话时消息里没有对应条目,map 无命中,天然无害
          setMessages((prev) => appendToolExecution(prev, event.messageId, event.execution))
          break
        case 'tool_end':
          setMessages((prev) =>
            updateToolExecution(prev, event.toolCallId, event.status, event.error),
          )
          setAllApprovals((prev) =>
            prev.map((card) =>
              card.request.toolCallId === event.toolCallId && card.phase === 'running'
                ? {
                    ...card,
                    phase: event.status,
                    ...(event.error ? { error: event.error } : {}),
                  }
                : card,
            ),
          )
          break
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
    }
  }, [bridge, loadRunDetail, scheduleRunDetailSync, scheduleUsageSync])

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
      case 'agent_end':
        setStreaming(false)
        streamingMessageIdRef.current = null
        setStreamingMessageId(null)
        break
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

  // 0.2.0:新建会话从角色卡发起;provider/model 沿用设置页当前选择,cwd 由主进程取角色主挂载
  const createSession = useCallback(
    async (roleId: string) => {
      const selection = settingsRef.current?.providerSelection
      if (!selection || sessionBusy) return
      setSessionBusy(true)
      try {
        const detail = await bridge.invoke('session:create', {
          roleId,
          providerId: selection.providerId,
          modelId: selection.modelId,
        })
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
    [bridge, rulesRoleId, showNotice],
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
        const userMessage = await bridge.invoke('message:send', { sessionId, text: trimmed })
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
    async (card: ApprovalCardState, decision: ApprovalDecision, note: string) => {
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
   * 「查看完整过程」(批 2b,PLAN §10.3):打开 internal 只读详情整页。
   * run 找不到(列表已换会话等)就不开,避免悬空页;打开即拉详情(去重由 loadRunDetail 管)。
   */
  const openAgentRunDetail = useCallback(
    (runId: string) => {
      const run = agentRunsRef.current.find((r) => r.runId === runId)
      if (run === undefined) return
      setRunDetailOpen({ runId, snapshot: run })
      loadRunDetail(runId)
      setView('agent-run-detail')
    },
    [loadRunDetail],
  )

  const closeAgentRunDetail = useCallback(() => {
    setRunDetailOpen(null)
    setView('chat')
  }, [])

  /** 传给 DelegationCard 的稳定动作合集;数据面(map/set)变化时才换新引用。 */
  const delegation: DelegationCardActions = useMemo(
    () => ({
      approvalFor: (runId) => delegationRequests.get(runId),
      detailFor: (runId) => runDetails.get(runId),
      detailLoadingFor: (runId) => runDetailLoading.has(runId),
      onLoadDetail: loadRunDetail,
      onOpenFullDetail: openAgentRunDetail,
      onRespond: respondDelegation,
    }),
    [delegationRequests, runDetails, runDetailLoading, loadRunDetail, openAgentRunDetail, respondDelegation],
  )

  /* ============ 设置与凭据 ============ */
  const selectProvider = useCallback(
    async (selection: ProviderSelection) => {
      const current = settingsRef.current
      if (!current) return
      const next = withProviderSelection(current, selection)
      setSettings(next) // 先本地生效,保存失败再回滚
      try {
        const saved = await bridge.invoke('settings:update', { settings: next })
        setSettings(saved)
      } catch (error) {
        setSettings(current)
        showNotice(humanizeError(error))
      }
    },
    [bridge, showNotice],
  )

  /** 思考强度:把现有 settings 原样加上 thinkingLevel 整体保存,下一条消息生效。 */
  const updateThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      const current = settingsRef.current
      if (!current) return
      const next: Settings = { ...current, thinkingLevel: level }
      setSettings(next)
      try {
        const saved = await bridge.invoke('settings:update', { settings: next })
        setSettings(saved)
      } catch (error) {
        setSettings(current)
        showNotice(humanizeError(error))
      }
    },
    [bridge, showNotice],
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
   * 详情整页(批 2b):run 优先取列表里的活体(agent_run_updated 实时变状态),
   * 列表里找不到(切了会话/角色被删等)退回打开时的快照,页面不塌。
   */
  const runDetailView = useMemo(() => {
    if (runDetailOpen === null) return null
    const run =
      agentRuns.find((r) => r.runId === runDetailOpen.runId) ?? runDetailOpen.snapshot
    return {
      run,
      detail: runDetails.get(runDetailOpen.runId),
      loading: runDetailLoading.has(runDetailOpen.runId),
    }
  }, [runDetailOpen, agentRuns, runDetails, runDetailLoading])

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
    respondApproval,
    agentRuns,
    delegation,
    runDetailView,
    openAgentRunDetail,
    closeAgentRunDetail,
    settings,
    selectProvider,
    updateThinkingLevel,
    credentials,
    saveCredential,
    deleteCredential,
    testCredential,
    reminders: visibleReminders,
    dismissReminder,
  }
}
