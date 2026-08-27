/**
 * 总管(0.3.0)领域模型——契约冻结,依据 docs/plans/manager-plan.md §2。
 *
 * 边界:AgentRun 是"一次派活"的运行实体,存 roles.sqlite.agent_runs;
 * 消息正文仍在 pi sessions.sqlite(internal 会话);usage 仍按 sessionId 记录,
 * 经 agent_runs.internal_session_id 映射到 run,不给 usage 表加列。
 */

/** 内置总管角色的固定 ID;种子化写入,不经过公共 role:create。 */
export const SYSTEM_MANAGER_ROLE_ID = 'sys-xiaozhen' as const

/** 派活运行 ID:run- + 16 位小写十六进制(主进程生成,模型/渲染层只读)。 */
export type AgentRunId = string

/** 派活状态机(awaiting-approval→queued→running→…→终态;非法跳转由仓储层拒绝)。 */
export type AgentRunStatus =
  | 'awaiting-approval' // 已校验待用户批准(占串行槽,尚无 internal 会话)
  | 'queued' // 用户已同意,正在创建 internal 会话
  | 'running' // 子 agent 干活中
  | 'waiting' // 等待中(reason 区分:等小柊轮询 / 等用户处理文件确认卡)
  | 'completed'
  | 'failed'
  | 'rejected' // 用户拒绝派出 / 确认卡超时
  | 'interrupted' // 应用上次在派活中途退出,启动恢复标记

export type AgentRunWaitingReason = 'manager-wait' | 'user-approval' | null

/** 排队原因(0.4.0 D,PLAN §6.2):queued 态才允许非空。 */
export type AgentRunQueueReason = 'dependency' | 'workspace-lock' | 'concurrency-limit' | null

/** 打断来源(0.4.0 D,PLAN §6.6):interrupted 态才允许非空;app-restart 不得伪装成用户打断。 */
export type AgentRunInterruptSource = 'user' | 'manager' | 'app-restart' | null

/** 协作链 ID(0.4.0 D):graph- + 16 位小写十六进制,主进程生成。 */
export type AgentGraphId = string

/**
 * 中转交棒信封(0.4.0 D,PLAN §6.3)——"只继承定论":
 * 服务端从 DB 权威 DelegationResult 构造,模型/渲染层只读;
 * 不含 child thinking/transcript 字段,worker 也拿不到 send_message 工具。
 */
export interface HandoffEnvelopeV1 {
  readonly schemaVersion: 1
  /** 定论来源 run(稳定排序;全部必须已 completed)。 */
  readonly sourceRunIds: readonly AgentRunId[]
  readonly conclusions: readonly string[]
  /** 已验证的产物路径(引用不授权:下游写权限仍由自己的 mounts/delegation 决定)。 */
  readonly artifactPaths: readonly string[]
  readonly unmetCriteria: readonly string[]
  /** 越界事实(boundary violations 的定论摘要)。 */
  readonly boundaryFacts: readonly string[]
  /**
   * 上游数据明细(A-19):每来源最多一条,带角色名前缀;来源未提供时该来源无条目。
   * 下游拿不到上游原始文件,核对要用的关键数字靠这里,不开放原件读取。
   */
  readonly detailData: readonly string[]
  /** 总管对交棒的补充结论。 */
  readonly managerConclusion: string
}

/** 协作链边(0.4.0 D):dependency=显式依赖;handoff=send_message 交棒建立的边。 */
export interface AgentRunGraphEdge {
  readonly fromRunId: AgentRunId
  readonly toRunId: AgentRunId
  readonly kind: 'dependency' | 'handoff'
}

/** 协作链视图(0.4.0 D,agentRun:getGraph 响应):图状态完全由 DTO 推导,renderer 不存第二份。 */
export interface AgentRunGraph {
  readonly graphId: AgentGraphId
  readonly managerSessionId: string
  readonly nodes: readonly AgentRunSummary[]
  readonly edges: readonly AgentRunGraphEdge[]
  readonly aggregate: {
    readonly active: number
    readonly completed: number
    readonly failed: number
    readonly interrupted: number
    readonly totalTokens: number
  }
}

/**
 * 派活信封:子 agent 可见的全部输入("只继承定论")。
 * 总管的思考、工具调用、其他角色对话、未整理猜测均无数据入口。
 */
export interface DelegationEnvelope {
  /** 用户原始需求(1~100_000 字)。 */
  readonly userRequest: string
  /** 总管已确认的定论(0~20 条,每条 1~2_000 字)。 */
  readonly managerConclusions: readonly string[]
  /** 给子角色的任务简报(1~4_000 字)。 */
  readonly taskBrief: string
  /** 验收要点(1~20 条,每条 1~1_000 字);总管按它核对产出。 */
  readonly acceptanceCriteria: readonly string[]
  /** 允许操作的文件夹(1~8 个绝对路径);必须是目标角色挂载目录的子集快照。 */
  readonly allowedWorkspacePaths: readonly string[]
}

/** 子 agent 的结构化结果(最后一条 assistant 消息里的版本化 JSON 块解析而来)。 */
export interface DelegationResult {
  readonly summary: string
  readonly conclusions: readonly string[]
  /** 产物路径;主进程再过严格路径策略,模型声称的越界产物不采信。 */
  readonly artifactPaths: readonly string[]
  /** 未完成的验收要点(保守 fallback 时全部标 unmet)。 */
  readonly unmetCriteria: readonly string[]
  /**
   * 数据明细(A-19,可选 1~4_000 字):产出中下游可能要核对的关键数字/条目。
   * 下游角色读不到上游的原始文件,交棒时这一段会随定论一起传给下游。
   */
  readonly detailData?: string
  /** 越界事实(主进程权威记录,不接受模型覆盖)。 */
  readonly boundaryViolations: readonly {
    readonly path: string
    readonly operation: 'read' | 'write'
    readonly reason: string
    readonly occurredAt: number
  }[]
}

/** 单次派活的用量(查询层按 internal sessionId 聚合 usage_events,不冗余落库)。 */
export interface AgentRunUsage {
  readonly rounds: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
}

/** 派活卡片数据(agentRun:list / agent_run_updated 推送体)。 */
export interface AgentRunSummary {
  readonly runId: AgentRunId
  /** 发起派活的 manager 用户会话。 */
  readonly managerSessionId: string
  readonly targetRoleId: string
  /** spawn 时快照;角色改名后历史卡仍可读。 */
  readonly targetRoleName: string
  /** internal pi 会话 ID;awaiting/rejected 阶段为 null。 */
  readonly internalSessionId: string | null
  /** 0.3.0 恒为 null,给 0.4.0 协作链留门。 */
  readonly parentRunId: AgentRunId | null
  readonly status: AgentRunStatus
  readonly waitingReason: AgentRunWaitingReason
  /** 所属协作链(0.4.0 D);单发派活也归入自己的单节点 graph。 */
  readonly graphId: AgentGraphId
  /** 显式依赖(0.4.0 D):空数组=可独立调度;同 graph 校验由服务端做。 */
  readonly dependsOnRunIds: readonly AgentRunId[]
  /** 排队原因(0.4.0 D):仅 queued 态非空。 */
  readonly queueReason: AgentRunQueueReason
  /** followup 追加次数(0.4.0 D)。 */
  readonly followupCount: number
  /** 打断来源(0.4.0 D):仅 interrupted 态非空。 */
  readonly interruptSource: AgentRunInterruptSource
  readonly taskBrief: string
  readonly allowedWorkspacePaths: readonly string[]
  readonly usage: AgentRunUsage
  readonly createdAt: number
  readonly startedAt: number | null
  readonly completedAt: number | null
  readonly updatedAt: number
  readonly failureMessage?: string
}

/** 派活详情(agentRun:getDetail 响应;internal 会话只读,不含任何写操作)。 */
export interface AgentRunDetail {
  readonly run: AgentRunSummary
  readonly envelope: DelegationEnvelope
  readonly result: DelegationResult | null
  /** 子 agent 完整过程(internal 会话只读快照);会话缺失时为 null(卡显示"过程会话缺失")。 */
  readonly childSession: import('./session').SessionDetail | null
  readonly readOnly: true
}

/** 启动引导里的总管信息(app:getBootstrapState.manager)。 */
export interface ManagerBootstrap {
  readonly roleId: typeof SYSTEM_MANAGER_ROLE_ID
  /** 启动默认打开的 manager 用户会话。 */
  readonly entrySessionId: string
}
