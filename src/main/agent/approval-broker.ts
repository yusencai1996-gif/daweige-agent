import { randomUUID } from 'node:crypto'
import type {
  ApprovalKind,
  ApprovalRequest,
  ApprovalResponse,
  DelegationApprovalRequest,
  FileApprovalRequest,
} from '../../shared/domain/approval'
import type { AgentRunId } from '../../shared/domain/manager'
import type { AgentPushEvent } from '../../shared/ipc/events'

/**
 * 确认 Broker(M4-02)。
 * beforeToolCall 遇到写操作/越界读取时:
 * 1. 生成 ApprovalRequest(人话摘要),推 approval_required 给渲染层;
 * 2. 挂起等待 approval:respond;
 * 3. 批准 → 调用方放行;拒绝 → 附言非空时作为 block reason 回传模型;
 * 4. 超时 / 会话 abort / 窗口关闭 → 统一按拒绝收尾,绝不"默认放行"。
 * (0.3.0 后端线将在此扩展 delegation 请求与 surface 归属,契约见 PLAN §6.3)
 */

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export interface ApprovalInput {
  sessionId: string
  /** 卡片展示归属;child 传 manager user session,普通会话不传。 */
  surfaceSessionId?: string
  /** 文件/守则类卡片;delegation(0.3.0)由 orchestrator 专用入口发起,不走本结构。 */
  kind: Exclude<ApprovalKind, 'delegation'>
  title: string
  description: string
  itemCount: number
  samplePaths: string[]
  recoverable: boolean
  outsideWorkspace: boolean
  toolCallId?: string
  toolName?: string
}

export interface DelegationApprovalInput {
  /** 授权 owner,必须是发起派活的 manager 用户会话。 */
  sessionId: string
  surfaceSessionId?: string
  runId: AgentRunId
  targetRoleId: string
  targetRoleName: string
  taskBrief: string
  allowedWorkspacePaths: readonly string[]
  acceptanceCriteria: readonly string[]
  title: string
  description: string
}

export type ApprovalOutcome =
  | { decision: 'approve' }
  | { decision: 'reject'; note?: string; timedOut?: boolean }

interface PendingApproval {
  request: ApprovalRequest
  sessionId: string
  surfaceSessionId?: string
  settle: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`确认请求不存在或已处理:${approvalId}`)
  }
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  /** 会话级授权(A-01):sessionId → 已放行工具名集合;仅内存,重启即清(安全边界)。 */
  private readonly sessionGrants = new Map<string, Set<string>>()

  constructor(private readonly emitEvent: (event: AgentPushEvent) => void) {}

  /** 该会话该工具是否已被"本次会话全部允许"放行。 */
  hasSessionGrant(sessionId: string, toolName: string): boolean {
    return this.sessionGrants.get(sessionId)?.has(toolName) ?? false
  }

  /** 会话删除等收尾时清除授权。 */
  clearSessionGrants(sessionId: string): void {
    this.sessionGrants.delete(sessionId)
  }

  /** 挂起等待用户确认。调用方(beforeToolCall)据此决定放行或阻止。 */
  async request(input: ApprovalInput): Promise<ApprovalOutcome> {
    const request: FileApprovalRequest = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      description: input.description,
      itemCount: input.itemCount,
      samplePaths: input.samplePaths.slice(0, 5),
      recoverable: input.recoverable,
      outsideWorkspace: input.outsideWorkspace,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      createdAt: Date.now(),
    }

    return this.enqueueRequest(request, input.sessionId, input.surfaceSessionId)
  }

  /** 总管派活专用入口;仍复用同一套超时/abort/close fail-closed 生命周期。 */
  async requestDelegation(input: DelegationApprovalInput): Promise<ApprovalOutcome> {
    const request: DelegationApprovalRequest = {
      id: randomUUID(),
      kind: 'delegation',
      runId: input.runId,
      targetRoleId: input.targetRoleId,
      targetRoleName: input.targetRoleName,
      taskBrief: input.taskBrief,
      allowedWorkspacePaths: [...input.allowedWorkspacePaths],
      acceptanceCriteria: [...input.acceptanceCriteria],
      title: input.title,
      description: input.description,
      createdAt: Date.now(),
    }
    return this.enqueueRequest(request, input.sessionId, input.surfaceSessionId)
  }

  private enqueueRequest(
    request: ApprovalRequest,
    sessionId: string,
    surfaceSessionId?: string,
  ): Promise<ApprovalOutcome> {
    const promise = new Promise<ApprovalOutcome>((settle) => {
      const timer = setTimeout(() => {
        // 超时按拒绝收尾,绝不默认放行
        this.pending.delete(request.id)
        this.emitResolved(sessionId, request.id, 'reject', surfaceSessionId)
        settle({ decision: 'reject', note: '等待确认超时,本次未执行', timedOut: true })
      }, APPROVAL_TIMEOUT_MS)

      this.pending.set(request.id, {
        request,
        sessionId,
        ...(surfaceSessionId !== undefined ? { surfaceSessionId } : {}),
        settle: (outcome) => {
          clearTimeout(timer)
          settle(outcome)
        },
        timer,
      })
    })

    this.safeEmit({
      type: 'approval_required',
      sessionId,
      request,
      ...(surfaceSessionId !== undefined ? { surfaceSessionId } : {}),
    })
    return promise
  }

  /** IPC approval:respond 入口;伪造/重复响应拒绝。 */
  resolve(response: ApprovalResponse): void {
    const pending = this.pending.get(response.approvalId)
    if (!pending) {
      throw new ApprovalNotFoundError(response.approvalId)
    }
    this.pending.delete(response.approvalId)
    const settledDecision = response.decision === 'reject' ? 'reject' : 'approve'
    this.emitResolved(
      pending.sessionId,
      response.approvalId,
      settledDecision,
      pending.surfaceSessionId,
    )
    if (response.decision === 'reject') {
      const note = response.note?.trim()
      pending.settle(note ? { decision: 'reject', note } : { decision: 'reject' })
      return
    }
    if (response.decision === 'approve-session') {
      // 登记会话级授权;无工具名时退化为单次批准。
      // 删除/越界/守则修改不吃会话授权(gate 消费侧也硬排除,此处双保险);
      // 守则工具即便登记也无消费路径,但源头不登记更干净(0.2.0 红线)。
      // delegation(0.3.0)同样永不登记:每次派活都必须用户点头。
      const req = pending.request
      if (
        req.kind !== 'delegation' &&
        req.toolName &&
        req.kind !== 'delete' &&
        req.kind !== 'role-rules-edit' &&
        !req.outsideWorkspace
      ) {
        let grants = this.sessionGrants.get(pending.sessionId)
        if (!grants) {
          grants = new Set<string>()
          this.sessionGrants.set(pending.sessionId, grants)
        }
        grants.add(req.toolName)
      }
    }
    pending.settle({ decision: 'approve' })
  }

  /** 会话 abort/删除时:该会话的全部待确认按拒绝收尾。 */
  /** 归档/删除前的忙碌检查:该会话是否有未决确认卡。 */
  hasPendingForSession(sessionId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) return true
    }
    return false
  }

  abortAllForSession(sessionId: string, reason = '会话已中断,本次未执行'): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        this.emitResolved(sessionId, id, 'reject', pending.surfaceSessionId)
        pending.settle({ decision: 'reject', note: reason })
      }
    }
  }

  /** 窗口关闭/应用退出:全部收尾。 */
  abortAll(reason = '应用已关闭,本次未执行'): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      this.emitResolved(pending.sessionId, id, 'reject', pending.surfaceSessionId)
      pending.settle({ decision: 'reject', note: reason })
    }
  }

  pendingCount(): number {
    return this.pending.size
  }

  private emitResolved(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    surfaceSessionId?: string,
  ): void {
    const event: AgentPushEvent = {
      type: 'approval_resolved',
      sessionId,
      approvalId,
      decision,
      ...(surfaceSessionId !== undefined ? { surfaceSessionId } : {}),
    }
    this.safeEmit(event)
  }

  /** 推送失败(如窗口销毁)不能打断确认 settle 流程。 */
  private safeEmit(event: AgentPushEvent): void {
    try {
      this.emitEvent(event)
    } catch (err) {
      console.error('[approval] 事件推送失败:', err instanceof Error ? err.message : err)
    }
  }
}
