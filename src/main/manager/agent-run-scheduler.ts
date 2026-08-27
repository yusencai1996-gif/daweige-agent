import {
  AgentRunTransitionError,
  type AgentRunRow,
  type RoleRepository,
} from '../roles/role-repository'

/**
 * 并发上限(PLAN §0.2 Gate 1 裁决:首版定 3,不可配置)。
 * waiting(user-approval/manager-wait)同样占槽:租约不释放,槽也不释放。
 */
export const MAX_CONCURRENT_AGENT_RUNS = 3

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'interrupted'])

export type TryStartOutcome = 'started' | 'lease-conflict' | 'gone'

export interface AgentRunSchedulerDeps {
  readonly roles: RoleRepository
  /**
   * 调度器决定启动某个 queued run 时回调(orchestrator 提供:
   * 建 internal session → acquireLeasesAndStart → 后台 executeWorker)。
   * - 'started':已原子转 running(租约已写)
   * - 'lease-conflict':根重叠,acquireLeasesAndStart 已留 queued+workspace-lock
   * - 'gone':run 已不处于 queued(并发竞争),本轮跳过
   */
  readonly tryStart: (run: AgentRunRow) => Promise<TryStartOutcome>
  /** 依赖级联把下游收 failed 时推送 agent_run_updated(orchestrator 的 emit 链)。 */
  readonly onCascadeFailed: (run: AgentRunRow) => Promise<void> | void
}

/**
 * 协作链调度器(PLAN §6.2):单进程串行决策层。
 * 每次 tick 按 (createdAt, runId) 稳定扫描 queued:
 * 1. 任一依赖终态但非 completed → 下游 failed("上游未完成");
 * 2. 依赖未全部终态 → 保持 queued(queueReason=dependency);
 * 3. 依赖全 completed + 并发槽有空位 → 交给 tryStart 原子启动(根互斥在租约原语内)。
 * 物理互斥的最终防线仍是 repository 的 BEGIN IMMEDIATE 事务(串行队列+事务双保险)。
 */
export class AgentRunScheduler {
  private ticking = false
  private pendingTick = false
  private disposed = false

  constructor(private readonly deps: AgentRunSchedulerDeps) {}

  /**
   * 触发一轮调度。批准后/终态后调用;并发触发自动合并(互斥执行,结束后补一轮),
   * 高频推送下天然防抖。永不 reject(backend 专审整改):级联竞态/退出关库等异常
   * 只记日志,不产生未处理 rejection 冒泡到 void 调用点。
   * 外层异常退出时保留 pendingTick 并补跑一轮(阶段复审整改:吞异常不能吞掉
   * 排队信号,否则后续节点可能永久滞留 queued)。
   */
  async tick(): Promise<void> {
    if (this.disposed) return
    if (this.ticking) {
      this.pendingTick = true
      return
    }
    this.ticking = true
    let failed = false
    try {
      do {
        this.pendingTick = false
        failed = false
        await this.runTick()
      } while (this.pendingTick && !this.disposed)
    } catch (error) {
      failed = true
      console.error('[manager] 调度 tick 异常(本轮放弃):', error instanceof Error ? error.message : error)
    } finally {
      this.ticking = false
      // 异常退出时若期间有新的触发(或本轮未消化完),补跑一轮;连续失败不再无限重试
      if (failed && this.pendingTick && !this.disposed) {
        this.pendingTick = false
        void this.tick()
      }
    }
  }

  /** 应用退出 drain 时停摆:不再启动新 worker。 */
  dispose(): void {
    this.disposed = true
  }

  private async runTick(): Promise<void> {
    const queued = await this.deps.roles.listQueuedAgentRuns()
    if (queued.length === 0) return
    let active = await this.deps.roles.countActiveRuns()
    for (const candidate of queued) {
      if (this.disposed) return
      // 错误隔离到单个 candidate(阶段复审整改):一个 run 的意外异常
      // 只记日志跳过,不吞掉本轮其余 run 的调度机会
      try {
        const started = await this.scheduleCandidate(candidate.runId, active)
        if (started) active += 1
      } catch (error) {
        console.error(
          '[manager] 调度单个派活异常(跳过,下一轮重判):',
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  /** 单个 queued run 的调度裁决;返回是否占了一个并发槽(started)。 */
  private async scheduleCandidate(runId: string, active: number): Promise<boolean> {
    // 快照可能过期:前序处理已改变状态,逐个 fresh 读
    const run = await this.deps.roles.getAgentRun(runId)
    if (!run || run.status !== 'queued') return false

    const depRows = await Promise.all(
      run.dependsOnRunIds.map((depId) => this.deps.roles.getAgentRun(depId)),
    )
    // 依赖级联:上游已终态但没成功 → 下游保守失败,不启动
    const failedDep = depRows.find(
      (dep) => dep && TERMINAL.has(dep.status) && dep.status !== 'completed',
    )
    if (failedDep) {
      // 级联转换兜底(backend 专审整改):fresh 读之后 run 恰被 interrupt/其他方收终态时,
      // 转换抛 AgentRunTransitionError——状态已被并发方推进,跳过即可(self-heal)
      try {
        const cascaded = await this.deps.roles.transitionAgentRun(run.runId, {
          status: 'failed',
          failureMessage: `上游派活(${failedDep.targetRoleNameSnapshot})没有完成,这条没有启动;请让小柊重新安排`,
        })
        await this.deps.onCascadeFailed(cascaded)
      } catch (error) {
        if (!(error instanceof AgentRunTransitionError)) throw error
      }
      return false
    }
    // 依赖还有没跑完的 → 继续排队(依赖未全部 completed 不 eligible)
    if (depRows.some((dep) => !dep || !TERMINAL.has(dep.status))) {
      await this.deps.roles
        .setAgentRunQueueReason(run.runId, 'dependency')
        .catch(() => {}) // 状态刚好变化时不必报错,下一轮 tick 会重判
      return false
    }
    // 并发槽满 → 排队记录原因
    if (active >= MAX_CONCURRENT_AGENT_RUNS) {
      await this.deps.roles
        .setAgentRunQueueReason(run.runId, 'concurrency-limit')
        .catch(() => {})
      return false
    }
    // 依赖齐+槽空位 → 原子启动(资格+根互斥+租约+running 同事务)
    const outcome = await this.deps.tryStart(run)
    // lease-conflict:原语已留 queued+workspace-lock;gone:竞争已处理,跳过
    return outcome === 'started'
  }
}
