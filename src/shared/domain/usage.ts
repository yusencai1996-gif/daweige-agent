/**
 * 使用统计领域类型——契约冻结(2026-08-24,PLAN docs/plans/usage-stats-plan.md §4)。
 *
 * 口径(契约评审定版):
 * - 总量统一使用 pi usage.totalTokens(input+output+cacheRead+cacheWrite);
 * - 费用不落库不传输(即使 pi usage 自带 cost);
 * - 模型展示键 = (provider, responseModel ?? model);
 * - 删除会话不删除历史统计(统计表达应用累计消耗);
 * - 一次 getDashboard 返回整页数据,四区域同源一致,前端筛选只做本地派生。
 */

/** 使用统计整页快照(usage:getDashboard 响应)。 */
export interface UsageDashboard {
  readonly schemaVersion: 2
  readonly generatedAt: number
  /** IANA 时区标识(聚合归日用,如 Asia/Shanghai)。 */
  readonly timeZone: string
  /** 是否有任何 usage 记录;false 时五卡返回零值、数组仍保持日期骨架。 */
  readonly hasData: boolean

  /** 总览五卡。 */
  readonly overview: {
    readonly totalTokens: number
    /** 单日峰值(按本地自然日汇总取最大)。 */
    readonly peakDailyTokens: number
    /** 最长活跃会话时长(相邻 usage 事件不超过 30 分钟的间隔累计,毫秒)。 */
    readonly longestActiveSessionDurationMs: number
    /** 当前连续使用天数;今天无用量则为 0。 */
    readonly currentStreakDays: number
    readonly longestStreakDays: number
  }

  /** 活动热力图:固定最近 365 个自然日(含今天),缺失日期补零。 */
  readonly activity: {
    readonly fromDate: string
    readonly toDate: string
    readonly days: readonly {
      /** YYYY-MM-DD(本地时区)。 */
      readonly date: string
      readonly totalTokens: number
    }[]
  }

  /** 趋势折线:固定最近 30 日,前端取尾 7 日实现"近 7 日"切换。 */
  readonly trend: {
    readonly fromDate: string
    readonly toDate: string
    readonly dates: readonly string[]
    /** 按模型分系列;模型键 = (provider, responseModel ?? model)。 */
    readonly series: readonly {
      readonly provider: string
      readonly model: string
      readonly values: readonly number[]
    }[]
  }

  /** 模型用量环形图 + 明细:按 token 降序;占比由前端除法计算(不提前四舍五入)。 */
  readonly models: {
    readonly totalTokens: number
    readonly items: readonly {
      readonly provider: string
      readonly model: string
      readonly totalTokens: number
    }[]
  }

  /**
   * 派活用量(0.3.0):既有总量的解释维度,不是第五份计费口径——
   * 子 agent 的 token 已按 internal sessionId 计入上面四区,这里只是按 run 归集展示。
   */
  readonly delegations: {
    readonly totalTokens: number
    readonly runs: readonly import('./manager').AgentRunSummary[]
  }
}
