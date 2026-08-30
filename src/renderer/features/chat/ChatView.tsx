import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentRunSummary,
  ApprovalDecision,
  ProviderInfo,
  ProviderSelection,
  Reminder,
  SessionDetail,
  ThinkingLevel,
} from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { ApprovalCardState, ContextUsageState } from '../../app/use-app-controller'
import { SYSTEM_MANAGER_ROLE_ID } from '../../../shared/domain/manager'
import { ReminderBanner } from '../reminders/ReminderBanner'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { CommandApprovalCard } from '../approvals/CommandApprovalCard'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { mergeTimeline } from '../manager/conversation-timeline'
import type { DelegationCardActions } from '../manager/DelegationCard'
import { CollaborationPanelHost } from '../manager/CollaborationPanelHost'
import type {
  CollabPanelActions,
  CollabPanelData,
} from '../manager/collab-panel-model'
import type { GuardrailsDraftCardActions } from '../manager/GuardrailsDraftCard'
import type { CommandLiveChunks } from './command-live'
import type { ChatMessage } from '../../../shared/domain'

interface ChatViewProps {
  readonly bridge: DaweigeBridge
  readonly detail: SessionDetail | null
  readonly detailLoading: boolean
  readonly hasSessions: boolean
  readonly messages: readonly ChatMessage[]
  /** 当前 manager 用户会话的派活卡列表(0.3.0;普通会话恒空),与 messages 按 createdAt 合并渲染。 */
  readonly agentRuns: readonly AgentRunSummary[]
  /** 派活卡动作合集(确认响应/详情懒加载)。 */
  readonly delegation: DelegationCardActions
  /** 协作链常驻面板(A-28):数据与动作;仅 manager 会话挂面板,其余会话 Host 也不会渲染。 */
  readonly collabPanel: CollabPanelData
  readonly collabPanelActions: CollabPanelActions
  /**
   * 守则草稿卡动作(批 2b,PLAN §10.5):好块成卡,预填打开既有界面;坏块只当普通文本。
   * 可选(阻断-3):只有总管(小柊)会话才传;普通 worker 会话不传,draft 块按普通代码块渲染。
   */
  readonly draftActions?: GuardrailsDraftCardActions
  /** 当前会话里 AI 的名字(A-13,跟角色走;无会话时兜底「小柊」):气泡名/欢迎页/空态文案统一用它。 */
  readonly roleName: string
  /** 正在流式输出的 assistant 消息 id(message_start 置位,message_end 清空);思考块据此自动展开/折叠。 */
  readonly streamingMessageId: string | null
  readonly approvals: readonly ApprovalCardState[]
  /** 命令实时输出(0.4.0 C):按 toolCallId 索引,CommandBlock 运行中数据源。 */
  readonly commandLive: ReadonlyMap<string, CommandLiveChunks>
  readonly streaming: boolean
  readonly sending: boolean
  readonly chatError: string | null
  readonly contextUsage: ContextUsageState | null
  /** 当前会话的未发送草稿(按会话隔离,A-12);随 activeSessionId 切换自动换槽。 */
  readonly draft: string
  readonly onDraftChange: (text: string) => void
  readonly providers: readonly ProviderInfo[]
  readonly selection: ProviderSelection
  /** 启用池(settings.enabledModels);undefined/空=老数据,模型面板回退只显示当前一项。 */
  readonly enabledModels?: readonly ProviderSelection[] | undefined
  readonly thinkingLevel: ThinkingLevel
  readonly reminders: readonly Reminder[]
  readonly onToggleSidebar: () => void
  readonly onSelectProvider: (selection: ProviderSelection) => void
  readonly onChangeThinking: (level: ThinkingLevel) => void
  /** 「存为该角色默认」入口(A-24):当前会话属角色(含小柊)时给;无角色会话为 null,入口不出现。 */
  readonly saveAsRoleDefault: {
    readonly roleName: string
    readonly canSave: boolean
    readonly onSave: () => void
  } | null
  readonly onSend: (text: string) => void
  readonly onAbort: () => void
  readonly onRetry: () => void
  readonly onRespondApproval: (
    card: ApprovalCardState,
    decision: ApprovalDecision,
    note: string,
  ) => void
  readonly onDismissReminder: (memoryId: string) => void
  /** 空应用欢迎页主按钮:打开新建角色向导(0.2.0 起新会话挂在角色下)。 */
  readonly onCreateRole: () => void
}

export function ChatView({
  bridge,
  detail,
  detailLoading,
  hasSessions,
  messages,
  agentRuns,
  delegation,
  collabPanel,
  collabPanelActions,
  draftActions,
  roleName,
  streamingMessageId,
  approvals,
  commandLive,
  streaming,
  sending,
  chatError,
  contextUsage,
  draft,
  onDraftChange,
  providers,
  selection,
  enabledModels,
  thinkingLevel,
  reminders,
  onToggleSidebar,
  onSelectProvider,
  onChangeThinking,
  saveAsRoleDefault,
  onSend,
  onAbort,
  onRetry,
  onRespondApproval,
  onDismissReminder,
  onCreateRole,
}: ChatViewProps) {
  const noSession = detail === null
  // 已归档会话:保留消息只读回看,输入区禁用(archivedAt 非空)
  const archived = detail !== null && detail.summary.archivedAt !== null
  // A-28:协作链常驻面板只挂在 manager(小柊)用户会话;普通角色会话不渲染任何面板元素
  const managerSession = detail !== null && detail.summary.roleId === SYSTEM_MANAGER_ROLE_ID
  // 详情态=「对话区压窄但不离开」(线框图):面板占右侧约 40%,对话区让出同宽右边距,
  // 输入框/发送钮不被面板盖住;窄窗(<1000px)详情铺满,不压(既定覆盖形态)
  const collabDetailOpen = managerSession && collabPanel.graph !== null && collabPanel.detailOpen
  const supportsThinking =
    providers.find((p) => p.id === selection.providerId)?.supportsThinking ?? false
  // 浮层只放未决/执行中的确认卡;批完(成功/拒绝/失败)即消失,结果看消息流里的工具状态行。
  const floatingApprovals = approvals.filter((c) => c.phase === 'pending' || c.phase === 'running')
  // 0.3.0(PLAN §10.2):消息与派活卡按 createdAt 稳定合并成一条时间线
  const timelineItems = useMemo(() => mergeTimeline(messages, agentRuns), [messages, agentRuns])

  // 窄窗(<1000px)详情态是覆盖形态:面板底边让出输入区整高,composer 永远可见可点(0.5.0 视觉验收 P1)。
  // 输入区随草稿行数自适应高度(textarea 最高 160px),CSS 不硬编码——实测高度写成 CSS 变量,
  // manager.css 窄窗规则读它算面板 bottom;宽窗该变量不被引用,写了也无害。
  const chatViewRef = useRef<HTMLDivElement | null>(null)
  const composerAreaRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = chatViewRef.current
    const composerArea = composerAreaRef.current
    if (root === null || composerArea === null) return
    const writeHeight = () => {
      root.style.setProperty('--composer-area-h', `${composerArea.getBoundingClientRect().height}px`)
    }
    writeHeight()
    const observer = new ResizeObserver(writeHeight)
    observer.observe(composerArea)
    return () => observer.disconnect()
  }, [])

  // 会话标题/工作文件夹已上移到标题栏;模型选择、思考强度下移进输入区工具行,
  // 原 chat-header 整行撤掉(窄屏侧栏开关挪进 Composer 工具行)。
  return (
    <div ref={chatViewRef} className={`chat-view${collabDetailOpen ? ' collab-detail-open' : ''}`}>
      {reminders.length > 0 && (
        <div className="reminder-stack">
          {reminders.map((reminder) => (
            <ReminderBanner
              key={reminder.memoryId}
              reminder={reminder}
              onDismiss={onDismissReminder}
            />
          ))}
        </div>
      )}

      {archived && (
        <div className="archived-banner" role="status">
          该会话已归档,可以回看;要继续聊,去「归档」里恢复它。
        </div>
      )}

      {noSession ? (
        hasSessions ? (
          <div className="chat-empty">
            <div className="chat-empty-inner">
              <div>从左边挑一条会话继续聊,</div>
              <div>或者在角色卡里点「＋ 新会话」开一个新的。</div>
            </div>
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-inner">
              <div className="welcome-title">{roleName}</div>
              <span className="welcome-dot" aria-hidden="true" />
              <div className="welcome-sub">
                你的桌面干活助理。
                <br />
                招一位伙伴,把工作文件夹交给它:整理文件、写稿、算表格、记琐事,
                <br />
                每动一样东西之前,它都会先问你。
              </div>
              <button type="button" className="btn btn-primary" onClick={onCreateRole}>
                先招一位伙伴吧
              </button>
            </div>
          </div>
        )
      ) : detailLoading ? (
        <div className="chat-empty">
          <div className="chat-empty-inner">正在翻这条会话的记录…</div>
        </div>
      ) : timelineItems.length === 0 && floatingApprovals.length === 0 ? (
        archived ? (
          <div className="chat-empty">
            <div className="chat-empty-inner">
              <div>这条已归档的会话没有留下消息。</div>
            </div>
          </div>
        ) : (
          <div className="chat-empty">
            <div className="chat-empty-inner">
              <div>这还是个空会话。</div>
              <div>在下面直接跟{roleName}说要干什么,比如「把这个文件夹里的图片按月份分好」。</div>
            </div>
          </div>
        )
      ) : (
        <MessageList
          items={timelineItems}
          roleName={roleName}
          streamingMessageId={streamingMessageId}
          onRetry={onRetry}
          delegation={delegation}
          draftActions={draftActions}
          commandLive={commandLive}
        />
      )}

      {chatError && (
        <div className="reminder-stack">
          <div className="reminder-banner" role="alert">
            <span className="reminder-dot" aria-hidden="true" />
            <span className="reminder-text">{chatError}</span>
          </div>
        </div>
      )}

      {/* 协作链常驻面板(A-28):右上锚定浮层,三态(小窗/面板/详情)由 Host 裁决;
          无 run 时 Host 返回 null,普通会话这里干脆不挂 */}
      {managerSession && (
        <CollaborationPanelHost
          data={collabPanel}
          actions={collabPanelActions}
          delegation={delegation}
        />
      )}

      <div className="composer-area" ref={composerAreaRef}>
        {floatingApprovals.length > 0 && (
          <div className="approval-overlay">
            <div className="approval-stack">
              {floatingApprovals.map((card) =>
                card.request.kind === 'command' ? (
                  <CommandApprovalCard key={card.request.id} card={card} onRespond={onRespondApproval} />
                ) : (
                  <ApprovalCard key={card.request.id} card={card} onRespond={onRespondApproval} />
                ),
              )}
            </div>
          </div>
        )}
        <Composer
          bridge={bridge}
          sessionId={detail?.summary.id ?? null}
          draft={draft}
          onDraftChange={onDraftChange}
          disabled={noSession || archived}
          archived={archived}
          streaming={streaming}
          sending={sending}
          contextUsage={contextUsage}
          providers={providers}
          selection={selection}
          enabledModels={enabledModels}
          supportsThinking={supportsThinking}
          thinkingLevel={thinkingLevel}
          onToggleSidebar={onToggleSidebar}
          onSelectProvider={onSelectProvider}
          onChangeThinking={onChangeThinking}
          saveAsRoleDefault={saveAsRoleDefault ?? undefined}
          onSend={onSend}
          onAbort={onAbort}
        />
      </div>
    </div>
  )
}
