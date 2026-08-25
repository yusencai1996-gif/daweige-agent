import type { ApprovalRequest } from '../domain/approval'
import type { ToolExecutionInfo, ToolExecutionStatus } from '../domain/message'

/**
 * agent:event 推送事件——覆盖流式文本、工具状态、确认、错误、结束。
 * 判别字段:type。
 */

export type AgentPushEvent =
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
    }
  | {
      readonly type: 'approval_resolved'
      readonly sessionId: string
      readonly approvalId: string
      readonly decision: 'approve' | 'reject'
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

export type AgentEventType = AgentPushEvent['type']

export function assertNeverAgentEvent(type: never): never {
  throw new Error(`未处理的 agent 事件类型: ${String(type)}`)
}
