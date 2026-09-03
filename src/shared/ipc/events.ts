import type { ApprovalRequest } from '../domain/approval'
import type { CompactionNoticeMessage, ToolExecutionInfo, ToolExecutionStatus } from '../domain/message'
import type { MemoryMergeState } from '../domain/memory'

/**
 * agent:event 推送事件——覆盖流式文本、工具状态、确认、错误、结束。
 * 判别字段:type。
 */

export type AgentPushEvent =
  | {
      readonly type: 'context_compacted'
      readonly sessionId: string
      readonly notice: CompactionNoticeMessage
      readonly contextUsage: {
        readonly usedTokens: number
        readonly contextWindow: number
      }
    }
  | {
      readonly type: 'message_start'
      readonly sessionId: string
      readonly messageId: string
      readonly createdAt: number
    }
  | {
      readonly type: 'text_delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
    }
  | {
      /** 模型思考过程的流式增量(A-02:前端聚合为可折叠思考块)。 */
      readonly type: 'thinking_delta'
      readonly sessionId: string
      readonly messageId: string
      readonly delta: string
    }
  | {
      readonly type: 'message_end'
      readonly sessionId: string
      readonly messageId: string
      /** 本次回复后的会话上下文占用(输入框右下角用量环数据源);无 usage 时缺省。 */
      readonly contextUsage?: {
        readonly usedTokens: number
        readonly contextWindow: number
      }
    }
  | {
      readonly type: 'tool_start'
      readonly sessionId: string
      readonly messageId: string
      readonly execution: ToolExecutionInfo
    }
  | {
      readonly type: 'tool_end'
      readonly sessionId: string
      readonly toolCallId: string
      readonly status: Extract<ToolExecutionStatus, 'succeeded' | 'rejected' | 'failed'>
      readonly error?: string
    }
  | {
      readonly type: 'approval_required'
      readonly sessionId: string
      readonly request: ApprovalRequest
      /**
       * 卡片显示在哪个用户会话(0.3.0):子 agent 的文件卡 sessionId=internal(授权归属),
       * surfaceSessionId=manager 用户会话(展示位置)。普通会话缺省,等价于 sessionId。
       */
      readonly surfaceSessionId?: string
    }
  | {
      readonly type: 'approval_resolved'
      readonly sessionId: string
      readonly approvalId: string
      readonly decision: 'approve' | 'reject'
      readonly surfaceSessionId?: string
    }
  | {
      readonly type: 'agent_error'
      readonly sessionId: string
      /** 中文错误信息,可直接展示。 */
      readonly message: string
      readonly retryable: boolean
    }
  | {
      readonly type: 'agent_end'
      readonly sessionId: string
    }
  | {
      /** 更新状态推送(设置页"检查更新"数据源;复用 agent:event 通道下发)。 */
      readonly type: 'update_state'
      readonly state: import('../domain/update').UpdateState
    }
  | {
      /** usage 行成功提交后推送(使用统计页防抖刷新;未打开页面无需响应)。 */
      readonly type: 'usage_updated'
      readonly generatedAt: number
    }
  | {
      readonly type: 'memory_changed'
      readonly revision: number
      readonly reason:
        | 'note-added'
        | 'note-deleted'
        | 'cleared'
        | 'migrated'
        | 'consolidated'
        | 'consolidation-failed'
      readonly mergeState: MemoryMergeState
    }
  | {
      /** 派活状态/用量变化(0.3.0):总管会话的派活卡数据源。 */
      readonly type: 'agent_run_updated'
      readonly managerSessionId: string
      readonly run: import('../domain/manager').AgentRunSummary
    }
  | {
      /** 命令实时输出(0.4.0 C);renderer 按 (sessionId,toolCallId,stream,sequence) 去重排序。 */
      readonly type: 'command_output'
      readonly sessionId: string
      readonly toolCallId: string
      readonly stream: import('../domain/command').CommandOutputStream
      readonly sequence: number
      /** UTF-8 文本,单 chunk ≤16 KiB。 */
      readonly chunk: string
      /** 截断标记(流被 cap 时最后一段带)。 */
      readonly truncated?: boolean
      /** 展示位置(同 approval surface 语义;child 命令卡显示在 manager 会话)。 */
      readonly surfaceSessionId?: string
    }
  | {
      /** 命令结束(0.4.0 C):结果摘要不含 stdout/stderr(完整结果在 pi 会话,刷新可重建)。 */
      readonly type: 'command_finished'
      readonly sessionId: string
      readonly toolCallId: string
      readonly result: Omit<import('../domain/command').CommandResultDetails, 'stdout' | 'stderr'>
      readonly surfaceSessionId?: string
    }

export type AgentEventType = AgentPushEvent['type']

/** 供 0.7.0 技能候选/安装卡按事件判别后直接取得精确 request 类型。 */
export type SkillApprovalPushEvent = Omit<
  Extract<AgentPushEvent, { readonly type: 'approval_required' }>,
  'request'
> & {
  readonly request:
    | import('../domain/approval').SkillCandidateApprovalRequest
    | import('../domain/approval').SkillInstallApprovalRequest
}

export function assertNeverAgentEvent(type: never): never {
  throw new Error(`未处理的 agent 事件类型: ${String(type)}`)
}
