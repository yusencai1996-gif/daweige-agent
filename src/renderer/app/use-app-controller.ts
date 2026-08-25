import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApprovalDecision,
  ApprovalRequest,
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
import { resolveActiveRoleName } from './active-role-name'
import { withProviderSelection } from '../features/settings/model-options'

/** 确认卡片阶段:pending(等用户)→ running(执行中…)→ succeeded/rejected/failed。 */
export type ApprovalPhase = 'pending' | 'running' | 'succeeded' | 'rejected' | 'failed'

export interface ApprovalCardState {
  /** 归属会话(切换会话再切回,等待中的卡片不丢)。 */
  readonly sessionId: string
  readonly request: ApprovalRequest
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
  readonly openWizard: () => void
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
  readonly openRoleRules: (roleId: string) => Promise<void>
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

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3200)
  }, [])

  const applyDetail = useCallback((detail: SessionDetail) => {
    setActiveDetail(detail)
    setActiveSessionId(detail.summary.id)
    setMessages(detail.messages)
    setStreaming(false)
    setChatError(null)
    setLastFailedText(null)
    setContextUsage(null) // 切换会话时清空用量环
    streamingMessageIdRef.current = null
    setStreamingMessageId(null)
    // 手风琴:当前会话所属角色自动展开
    if (detail.summary.roleId !== null) setExpandedRoleId(detail.summary.roleId)
  }, [])

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
    } catch (error) {
      setBootstrapError(humanizeError(error))
    }
  }, [bridge, openSession])

  useEffect(() => {
    void bootstrapOnce()
  }, [bootstrapOnce])

  /* ============ agent 事件流 ============ */
  useEffect(() => {
    const unsubscribe = bridge.onAgentEvent((event: AgentPushEvent) => {
      // 更新状态是应用级事件,与会话无关
      if (event.type === 'update_state') {
        setUpdateState(event.state)
        return
      }
      // usage 更新通知由使用统计页自行订阅刷新,会话事件流不处理
      if (event.type === 'usage_updated') return
      // 确认类事件(approval_*/tool_*)不限会话记录——卡片按会话归属保存,
      // 切走的会话弹确认卡也不丢(复审 S-01);消息流事件只处理当前会话。
      const isCurrentSession = event.sessionId === activeSessionIdRef.current
      switch (event.type) {
        case 'approval_required':
          setAllApprovals((prev) => [
            ...prev,
            {
              sessionId: event.sessionId,
              request: event.request,
              phase: 'pending',
              responded: false,
            },
          ])
          break
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
    return unsubscribe
  }, [bridge])

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
    setAllApprovals((prev) => prev.filter((c) => c.sessionId !== sessionId))
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
        setAllApprovals((prev) => prev.filter((c) => !deletedIds.has(c.sessionId)))
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
  const openRoleRules = useCallback(
    async (roleId: string) => {
      setRulesRoleId(roleId)
      setRulesDetail(null)
      setRulesLoading(true)
      setView('role-rules')
      try {
        const detail = await bridge.invoke('role:get', { roleId })
        setRulesDetail(detail)
      } catch (error) {
        showNotice(humanizeError(error))
        setRulesRoleId(null)
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

  /* ============ 提醒 ============ */
  const dismissReminder = useCallback((memoryId: string) => {
    setDismissedReminders((prev) => [...prev, memoryId])
  }, [])

  const visibleReminders = reminders.filter((r) => !dismissedReminders.includes(r.memoryId))

  /** 当前会话的确认卡(其他会话的留在状态里,切回去不丢)。 */
  const approvals = allApprovals.filter((c) => c.sessionId === activeSessionId)

  // A-13:AI 名字跟角色走——会话换了角色,气泡名与空态文案立刻跟着换
  const activeRoleName = resolveActiveRoleName(roles, activeDetail)

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
    openWizard: () => setWizardOpen(true),
    closeWizard: () => setWizardOpen(false),
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
