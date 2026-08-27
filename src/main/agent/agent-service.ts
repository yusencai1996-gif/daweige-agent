import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { Session } from '@earendil-works/pi-agent-core'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  UserMessage,
} from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../../shared/domain/message'
import type { ProviderSelection } from '../../shared/domain/provider'
import type { ThinkingLevel } from '../../shared/domain/settings'
import type { AgentPushEvent } from '../../shared/ipc/events'
import type { SessionService } from '../storage/session-service'
import type { UsageRecorder } from '../usage/usage-service'
import { entriesToAgentMessages, entriesToChatMessages, TOOL_DISPLAY_NAMES } from './message-mapper'
import { translateConnectivityError } from './connectivity-service'
import {
  composeSystemPrompt,
  type DelegationPromptLayer,
  type ManagerPromptLayer,
  type RolePromptLayer,
} from './prompt-composer'
import { redactCommonSecrets } from '../security/redaction'

/**
 * Agent Service(M3-04):每个活跃会话一个 pi Agent。
 * - 发送:持久化 user 消息 → agent.prompt 后台运行(事件流推给渲染层)
 * - 持久化:message_end 监听器 await appendMessage(Agent.subscribe 保证顺序,持久化屏障)
 * - 恢复:懒创建时从 SQLite 读回全部消息重建 transcript
 * - abort:agent.abort(),中断消息照常持久化(保留痕迹)
 */

/** 可注入的模型访问层(生产=ProviderRegistry;测试=faux)。 */
export interface AgentModels {
  getModel(providerId: string, modelId: string): Model<Api>
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream
}

export interface AgentTurnInput {
  readonly sessionId: string
  readonly text: string
  readonly selection: ProviderSelection
  /** internal child 会话不需要根据任务简报改会话标题。 */
  readonly updateTitle?: boolean
}

export interface AgentTurnResult {
  readonly sessionId: string
  readonly status: 'completed' | 'aborted' | 'failed'
  readonly finalText: string
  readonly errorMessage?: string
}

export interface AgentTurnRunner {
  run(input: AgentTurnInput): Promise<AgentTurnResult>
  abortSession(sessionId: string): void
  /** followup 追加的窄接口(0.4.0 D,PLAN §6.5):会话不活跃时抛错。 */
  steerSession(sessionId: string, text: string): Promise<void>
}

export interface SessionToolchain {
  tools: AgentTool[]
  beforeToolCall?: ConstructorParameters<typeof Agent>[0]['beforeToolCall']
}

export interface AgentServiceDeps {
  models: AgentModels
  sessionService: SessionService
  emitEvent: (event: AgentPushEvent) => void
  /**
   * 每个会话的工具链工厂(M4:文件工具 + 确认闸门,per-session PathPolicy)。
   * 未提供时会话无工具(纯对话)。
   */
  toolchain?: (
    ctx: { sessionId: string; workspacePath: string },
  ) => SessionToolchain | Promise<SessionToolchain>
  /** 静态上下文附注(M5:已有记事摘要),追加到系统提示词。 */
  contextNotes?: () => Promise<readonly string[]>
  /**
   * 会话的角色提示词层(0.2.0):每回合现场读取最新守则;
   * 未提供(会话无绑定/角色功能未初始化)时只有全局底子。
   */
  rolePrompt?: (sessionId: string) => Promise<RolePromptLayer | undefined>
  /** 0.3.0 每回合现场读取的总管/child 层;不缓存 roster 或 envelope。 */
  orchestrationPrompt?: (sessionId: string) => Promise<{
    readonly manager?: ManagerPromptLayer
    readonly delegation?: DelegationPromptLayer
    readonly workspacePaths?: readonly string[]
  }>
  /** 当前思考强度(off/未设置 → 不传 reasoning,走模型默认行为)。 */
  thinkingLevel?: () => ThinkingLevel | undefined
  /** 使用统计记录(usage 模块);未提供时跳过记录(测试/降级)。 */
  usageRecorder?: UsageRecorder
  /**
   * 0.4.0 A(A-14):会话 effective cwd 覆盖钩子(session-service 实现,manager 会话生效)。
   * 返回值替代 pi meta.cwd 作为工具写根与系统提示词工作区;未提供时沿用 meta.cwd。
   */
  managerCwdOverride?: (sessionId: string) => Promise<string | undefined>
}

class ActiveAgent {
  /** 渲染层消息 id:同一条 AgentMessage 的 start/delta/end 事件复用。 */
  readonly messageIds = new WeakMap<AgentMessage, string>()
  /** 当前流式 assistant 消息 id:partial 副本引用可能变化,fallback 到单槽。 */
  streamingMessageId: string | undefined

  constructor(
    readonly sessionId: string,
    readonly agent: Agent,
    readonly session: Session<SqliteSessionMetadata>,
    /** 会话工作目录(建 Agent 时取一次,提示词每回合重拼时复用)。 */
    readonly workspacePath: string,
  ) {}
}

export class AgentBusyError extends Error {
  constructor() {
    super('当前会话正在回复,请等它说完或点停止')
  }
}

export class ModelNotReadyError extends Error {
  constructor(providerId: string) {
    super(`厂商 ${providerId} 的模型还没准备好`)
  }
}

export class AgentService implements AgentTurnRunner {
  private readonly active = new Map<string, ActiveAgent>()

  constructor(private readonly deps: AgentServiceDeps) {}

  /**
   * 发送用户消息:立即持久化并返回 ChatMessage(乐观渲染锚点);
   * agent 循环在后台运行,回复经事件流推送。
   */
  async send(sessionId: string, text: string, selection: ProviderSelection): Promise<ChatMessage> {
    const { active, userMessage, entryId } = await this.prepareTurn({
      sessionId,
      text,
      selection,
    })
    // 普通聊天保持现有 fire-and-forget 语义,不 await 终态。
    void this.executeTurn(active, userMessage)

    return {
      kind: 'chat',
      id: entryId,
      role: 'user',
      text,
      createdAt: userMessage.timestamp,
    }
  }

  /** WorkerRunner 可 await 的生产适配器;与 send 共用同一 Agent/持久化/事件映射。 */
  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const { active, userMessage } = await this.prepareTurn(input)
    return this.executeTurn(active, userMessage)
  }

  abort(sessionId: string): void {
    this.abortSession(sessionId)
  }

  abortSession(sessionId: string): void {
    this.active.get(sessionId)?.agent.abort()
  }

  /**
   * followup 追加(0.4.0 D,PLAN §6.5):先持久化 user message 到 pi 会话,
   * 再注入 steering 队列——pi 在当前 assistant turn 完成后、下一轮模型调用前消费;
   * 正等工具确认时先等确认 resolve,turn 边界收到补充。不新增会话,usage 继续按本会话归集。
   * isStreaming 前置检查(阶段复审整改):turn 已结束的会话 steering 队列无人排空,
   * 消息持久化后只会变成无人消费的死 transcript——趁还没写入就拒绝。
   */
  async steerSession(sessionId: string, text: string): Promise<void> {
    const active = this.active.get(sessionId)
    if (!active) throw new Error('这条派活当前不在干活,补充要求送不进去')
    if (!active.agent.state.isStreaming) {
      throw new Error('这条派活的当前步骤刚好结束了,补充要求没有送进去;请让小柊重新派活')
    }
    const userMessage: UserMessage = { role: 'user', content: text, timestamp: Date.now() }
    await active.session.appendMessage(userMessage)
    active.agent.steer(userMessage)
  }

  /** 归档/删除前的忙碌检查:该会话是否正在流式回复。 */
  isSessionStreaming(sessionId: string): boolean {
    return this.active.get(sessionId)?.agent.state.isStreaming ?? false
  }

  /** 会话删除/切换后释放活跃 agent。 */
  disposeAgent(sessionId: string): void {
    const active = this.active.get(sessionId)
    if (active) {
      active.agent.abort()
      this.active.delete(sessionId)
    }
  }

  /** 打开会话时给渲染层的消息列表(复用 agent 恢复逻辑)。 */
  async restoreChatMessages(sessionId: string): Promise<ChatMessage[]> {
    const session = await this.deps.sessionService.openPiSession(sessionId)
    const entries = await session.findEntriesOnBranch({ order: 'oldestFirst' })
    return entriesToChatMessages(entries)
  }

  private async ensureAgent(sessionId: string, selection: ProviderSelection): Promise<ActiveAgent> {
    const session = await this.deps.sessionService.openPiSession(sessionId)
    const entries = await session.findEntriesOnBranch({ order: 'oldestFirst' })
    const model = this.resolveModel(selection)
    const meta = await session.getMetadata()
    const orchestration = await this.deps.orchestrationPrompt?.(sessionId)
    // 0.4.0 A:manager 会话的 effective cwd 跟随 resolver 当前值(迁移后旧会话立即指向新位置)
    const effectiveCwd = (await this.deps.managerCwdOverride?.(sessionId)) ?? meta.cwd
    const [toolchain, memoryNotes, role] = await Promise.all([
      this.deps.toolchain?.({ sessionId, workspacePath: effectiveCwd }),
      orchestration?.delegation ? [] : (this.deps.contextNotes?.() ?? []),
      this.deps.rolePrompt?.(sessionId),
    ])

    const agent = new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt({
          workspacePath: effectiveCwd,
          memories: memoryNotes ?? [],
          role,
          ...(orchestration?.manager ? { manager: orchestration.manager } : {}),
          ...(orchestration?.delegation ? { delegation: orchestration.delegation } : {}),
          ...(orchestration?.workspacePaths
            ? { workspacePaths: orchestration.workspacePaths }
            : {}),
        }),
        model,
        tools: toolchain?.tools ?? [],
        messages: entriesToAgentMessages(entries),
      },
      streamFn: (m, context, options) => {
        const level = this.deps.thinkingLevel?.()
        const reasoning = level && level !== 'off' ? level : undefined
        return this.deps.models.streamSimple(
          m,
          context,
          reasoning ? { ...options, reasoning } : options,
        )
      },
      toolExecution: 'sequential',
      beforeToolCall: toolchain?.beforeToolCall,
    })

    const active = new ActiveAgent(sessionId, agent, session, effectiveCwd)
    this.wireEvents(active)
    this.active.set(sessionId, active)
    return active
  }

  /** 每回合重读最新角色守则+记事索引,重建系统提示词(守则改动下一条消息生效)。 */
  private async refreshSystemPrompt(active: ActiveAgent): Promise<void> {
    const orchestration = await this.deps.orchestrationPrompt?.(active.sessionId)
    const [memoryNotes, role] = await Promise.all([
      orchestration?.delegation ? [] : (this.deps.contextNotes?.() ?? []),
      this.deps.rolePrompt?.(active.sessionId),
    ])
    active.agent.state.systemPrompt = composeSystemPrompt({
      workspacePath: active.workspacePath,
      memories: memoryNotes ?? [],
      role,
      ...(orchestration?.manager ? { manager: orchestration.manager } : {}),
      ...(orchestration?.delegation ? { delegation: orchestration.delegation } : {}),
      ...(orchestration?.workspacePaths
        ? { workspacePaths: orchestration.workspacePaths }
        : {}),
    })
  }

  private syncModel(active: ActiveAgent, selection: ProviderSelection): void {
    const current = active.agent.state.model
    if (
      (current as unknown as { provider?: string; id?: string }).provider !== selection.providerId ||
      current.id !== selection.modelId
    ) {
      active.agent.state.model = this.resolveModel(selection)
    }
  }

  private resolveModel(selection: ProviderSelection): Model<Api> {
    try {
      return this.deps.models.getModel(selection.providerId, selection.modelId)
    } catch {
      throw new ModelNotReadyError(selection.providerId)
    }
  }

  private wireEvents(active: ActiveAgent): void {
    const { sessionId, agent } = active
    agent.subscribe(async (event) => {
      switch (event.type) {
        case 'message_start': {
          if (event.message.role !== 'assistant') return
          const messageId = randomUUID()
          active.messageIds.set(event.message, messageId)
          active.streamingMessageId = messageId
          this.push({ type: 'message_start', sessionId, messageId, createdAt: Date.now() })
          return
        }
        case 'message_update': {
          if (event.message.role !== 'assistant') return
          const evt = event.assistantMessageEvent
          if (evt.type !== 'text_delta' && evt.type !== 'thinking_delta') return
          // partial 消息在流式过程中可能是新副本:WeakMap 命中或退回当前流式槽
          const messageId =
            active.messageIds.get(event.message) ?? active.streamingMessageId
          if (!messageId) return
          this.push({
            type: evt.type === 'thinking_delta' ? 'thinking_delta' : 'text_delta',
            sessionId,
            messageId,
            delta: evt.delta,
          })
          return
        }
        case 'message_end': {
          if (event.message.role === 'user') return // user 消息已在 send() 持久化
          // 引用补登先于持久化 await:messageId 计算不依赖落库结果,
          // 若 pi 某版本不再串行 await 监听器,补登晚于 tool_execution_start 仍会 miss
          const messageIdEarly =
            active.messageIds.get(event.message) ?? active.streamingMessageId
          if (messageIdEarly) {
            // pi 流式每帧浅拷贝 message:message_start 存的是首帧拷贝,finalMessage 真实引用
            // 从未入表,后续 tool_execution_start 按它查表会 miss(工具行挂不上消息)。
            // 这里把最终引用补登进表,同 id 覆盖幂等。
            active.messageIds.set(event.message, messageIdEarly)
            // 双保险:查表方用的是 state.messages 里的引用(lastAssistant),两者理论同源;
            // 若 pi 未来某版本在 state 里存的是另一份最终拷贝,这里保证查表引用同样命中
            const anchor = lastAssistant(active)
            if (anchor !== undefined) active.messageIds.set(anchor, messageIdEarly)
          }
          // 持久化屏障:subscribe 监听器按序 await,这条落库完成后事件流才继续。
          // pi 的 Session 校验拒绝含 undefined 的 payload(如 faux/流聚合留下的显式
          // undefined 字段),入库存前统一清洗;清洗后仍失败不阻断事件流,只记日志。
          let usageEntryId: string | undefined
          try {
            usageEntryId = await active.session.appendMessage(stripUndefined(event.message))
          } catch (err) {
            console.error(
              `[agent] 消息持久化失败(会话 ${sessionId}):`,
              redactCommonSecrets(err instanceof Error ? err.message : String(err)),
            )
          }
          // 使用统计:assistant 消息携带本轮模型调用的 token 用量;记录失败绝不影响事件流
          if (usageEntryId && this.deps.usageRecorder) {
            try {
              if (event.message.role === 'assistant') {
                this.deps.usageRecorder.recordAssistantMessage({
                  sourceEntryId: usageEntryId,
                  sessionId,
                  message: event.message,
                })
              }
              const at = (event.message as { timestamp?: number }).timestamp
              if (typeof at === 'number' && Number.isFinite(at)) {
                this.deps.usageRecorder.recordMessageSpan(sessionId, at)
              }
            } catch (err) {
              console.error('[agent] usage 记录异常(已忽略):', err)
            }
          }
          const messageId =
            active.messageIds.get(event.message) ?? active.streamingMessageId
          if (messageId) {
            // 上下文用量环:input+cacheRead 是已进入上下文的部分,加本次新产出 output
            const usage = 'usage' in event.message ? event.message.usage : undefined
            const contextWindow = active.agent.state.model.contextWindow
            const usedTokens =
              typeof usage?.input === 'number'
                ? usage.input + (usage.cacheRead ?? 0) + (usage.output ?? 0)
                : undefined
            this.push({
              type: 'message_end',
              sessionId,
              messageId,
              ...(usedTokens !== undefined && usedTokens > 0
                ? { contextUsage: { usedTokens, contextWindow } }
                : {}),
            })
          }
          active.streamingMessageId = undefined
          return
        }
        case 'tool_execution_start': {
          const anchor = lastAssistant(active)
          const messageId = anchor ? active.messageIds.get(anchor) : undefined
          // 哨兵:引用同源性假设被 pi 升级打破时第一时间暴露(工具行会挂不上消息)
          if (anchor && !messageId) {
            console.warn(`[agent] tool_execution_start 未命中消息映射(会话 ${sessionId},工具 ${event.toolName});pi 引用行为可能已变化`)
          }
          this.push({
            type: 'tool_start',
            sessionId,
            messageId: messageId ?? '',
            execution: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              displayName: TOOL_DISPLAY_NAMES[event.toolName] ?? event.toolName,
              status: 'running',
              // run_command 运行中给命令摘要(头部展示;终值由 command_finished/details 提供)
              ...(event.toolName === 'run_command' &&
              typeof (event.args as { command?: unknown } | undefined)?.command === 'string'
                ? {
                    summary: commandSummary(
                      (event.args as { command: string }).command,
                    ),
                  }
                : {}),
            },
          })
          return
        }
        case 'tool_execution_end': {
          this.push({
            type: 'tool_end',
            sessionId,
            toolCallId: event.toolCallId,
            status: event.isError ? 'failed' : 'succeeded',
          })
          return
        }
        default:
          return
      }
    })
  }

  private async prepareTurn(input: AgentTurnInput): Promise<{
    active: ActiveAgent
    userMessage: UserMessage
    entryId: string
  }> {
    const existing = this.active.get(input.sessionId)
    if (existing?.agent.state.isStreaming) throw new AgentBusyError()
    const active = existing ?? (await this.ensureAgent(input.sessionId, input.selection))
    this.syncModel(active, input.selection)
    await this.refreshSystemPrompt(active)
    const userMessage: UserMessage = {
      role: 'user',
      content: input.text,
      timestamp: Date.now(),
    }
    const entryId = await active.session.appendMessage(userMessage)
    try {
      this.deps.usageRecorder?.recordMessageSpan(input.sessionId, userMessage.timestamp)
    } catch (err) {
      console.error('[agent] usage 跨度记录异常(已忽略):', err)
    }
    if (input.updateTitle !== false) await this.maybeUpdateTitle(active, input.text)
    return { active, userMessage, entryId }
  }

  private async executeTurn(
    active: ActiveAgent,
    userMessage: UserMessage,
  ): Promise<AgentTurnResult> {
    try {
      // prompt 传已持久化的消息对象,agent 只把它并入 transcript,不重复入库
      await active.agent.prompt([userMessage])
      return {
        sessionId: active.sessionId,
        status: 'completed',
        finalText: finalAssistantText(active.agent.state.messages),
      }
    } catch (err) {
      if (isAbortError(err)) {
        return { sessionId: active.sessionId, status: 'aborted', finalText: '' }
      } else {
        const message = translateConnectivityError(err, [])
        this.push({ type: 'agent_error', sessionId: active.sessionId, message, retryable: true })
        return {
          sessionId: active.sessionId,
          status: 'failed',
          finalText: finalAssistantText(active.agent.state.messages),
          errorMessage: message,
        }
      }
    } finally {
      this.push({ type: 'agent_end', sessionId: active.sessionId })
    }
  }

  private async maybeUpdateTitle(active: ActiveAgent, text: string): Promise<void> {
    const name = await active.session.getName()
    if (name && name !== '新会话') return
    const title = text.trim().slice(0, 20) || '新会话'
    await active.session.setName(title)
  }

  private push(event: AgentPushEvent): void {
    this.deps.emitEvent(event)
  }
}

function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: 'text'; text: string } =>
          Boolean(
            part &&
              typeof part === 'object' &&
              'type' in part &&
              part.type === 'text' &&
              'text' in part &&
              typeof part.text === 'string',
          ),
        )
        .map((part) => part.text)
        .join('')
    }
  }
  return ''
}

function lastAssistant(active: ActiveAgent): AgentMessage | undefined {
  const messages = active.agent.state.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: AgentMessage | undefined = messages[i]
    if (m && m.role === 'assistant') return m
  }
  return undefined
}

/** run_command 运行中的命令摘要(压到 120 字符;完整原文在终值 details.command)。 */
function commandSummary(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= 120) return oneLine
  return `${oneLine.slice(0, 120)}…`
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/abort/i.test(err.name) || /abort/i.test(err.message))
  )
}

/**
 * 深拷贝并丢弃值为 undefined 的键(pi Session 持久化校验要求 JSON 可序列化)。
 * 原样保留基本类型与 Date;plain object/array 递归。
 */
export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = stripUndefined(v)
  }
  return out as T
}
