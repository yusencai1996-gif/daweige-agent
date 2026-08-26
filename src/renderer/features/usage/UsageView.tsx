import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UsageDashboard } from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import { isIpcErrorPayload } from '../../../shared/ipc/errors'
import { UsageOverviewCards } from './UsageOverviewCards'
import { TokenHeatmap } from './TokenHeatmap'
import { TokenTrendChart } from './TokenTrendChart'
import { ModelDonutChart } from './ModelDonutChart'
import { modelColorMap } from './usage-geometry'
import { formatTokens } from './usage-format'

interface UsageViewProps {
  readonly bridge: DaweigeBridge
  readonly onBack: () => void
}

function humanizeError(error: unknown): string {
  if (isIpcErrorPayload(error)) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 请求代次闸门(S-02):组件卸载或存在更新请求时,过期响应一律丢弃。
 * - 每次发起请求领取递增代次号;只有「最新代次 + 组件在挂载」才允许落地 setState;
 * - StrictMode 双跑 effect(卸载→重挂载,同一 ref)下:mount() 复位挂载态,
 *   代次号不清零,双发请求中旧代次响应自然被丢弃(顺便去重双拉)。
 */
export interface RequestGate {
  /** 组件(重新)挂载:恢复接受响应。 */
  readonly mount: () => void
  /** 组件卸载:此后所有代次一律作废。 */
  readonly unmount: () => void
  /** 发起一次请求,领取代次号。 */
  readonly begin: () => number
  /** 该代次的响应是否允许落地(组件在挂载且代次最新)。 */
  readonly accept: (generation: number) => boolean
}

/**
 * 派活用量折叠区(0.3.0 批 2b,PLAN §9.3):既有总量的解释维度,不是第五份计费口径。
 * 默认折叠,不挤现有四区;展开后按 run 显示目标角色名/任务简报(一行截断)/轮次/总 token,
 * 头部给小计 totalTokens。runs 为空时整区不渲染(由调用处判断,不加空状态文案)。
 */
function DelegationUsageSection({
  delegations,
}: {
  readonly delegations: UsageDashboard['delegations']
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="usage-section usage-delegations">
      <div className="usage-section-head">
        <h3 className="usage-section-title">派活用量</h3>
        <div className="usage-delegations-head-right">
          <span className="usage-delegations-subtotal muted">
            小计 {formatTokens(delegations.totalTokens)} tokens
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>
      {open && (
        <ul className="usage-delegation-list">
          {delegations.runs.map((run) => (
            <li key={run.runId} className="usage-delegation-row">
              <span className="usage-delegation-name">{run.targetRoleName}</span>
              <span className="usage-delegation-brief" title={run.taskBrief}>
                {run.taskBrief}
              </span>
              <span className="usage-delegation-meta muted">
                轮次 {run.usage.rounds} · {formatTokens(run.usage.totalTokens)} tokens
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function createRequestGate(): RequestGate {
  let mounted = true
  let generation = 0
  return {
    mount: () => {
      mounted = true
    },
    unmount: () => {
      mounted = false
    },
    begin: () => ++generation,
    accept: (gen) => mounted && gen === generation,
  }
}

/**
 * 使用统计整页:加载/错误/空态/刷新/防抖。
 * usage_updated 推送 → 250ms 防抖重拉;本页未打开(未挂载)时不发起任何请求。
 * 异步落地经 RequestGate 守卫:卸载后/过期代次的响应不触碰状态。
 */
export function UsageView({ bridge, onBack }: UsageViewProps) {
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null)
  const [loading, setLoading] = useState(true) // 仅首次加载显示整页骨架
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)
  const gateRef = useRef<RequestGate | null>(null)
  if (gateRef.current === null) gateRef.current = createRequestGate()

  /* 挂载态接入闸门(StrictMode 下同一 ref 会经历 卸载→重挂载) */
  useEffect(() => {
    const gate = gateRef.current!
    gate.mount()
    return () => gate.unmount()
  }, [])

  const load = useCallback(async () => {
    const gate = gateRef.current!
    const gen = gate.begin()
    try {
      const data = await bridge.invoke('usage:getDashboard', undefined)
      if (!gate.accept(gen)) return
      setDashboard(data)
      setError(null)
    } catch (err) {
      if (!gate.accept(gen)) return
      setError(humanizeError(err))
    } finally {
      /* 过期代次不得清 loading/refreshing:新请求仍在途,由它的 finally 收尾 */
      if (gate.accept(gen)) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  /* usage 落库推送 → 防抖刷新(页面打开才订阅;卸载即不再拉取) */
  useEffect(() => {
    const unsubscribe = bridge.onAgentEvent((event) => {
      if (event.type !== 'usage_updated') return
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => void load(), 250)
    })
    return () => {
      unsubscribe()
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    }
  }, [bridge, load])

  const refresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void load()
  }

  const colorMap = useMemo(
    () => (dashboard ? modelColorMap(dashboard.models.items) : new Map<string, number>()),
    [dashboard],
  )

  return (
    <div className="usage-pane">
      <div className="usage-column">
        <div className="usage-header">
          <div className="usage-header-left">
            <button type="button" className="btn btn-ghost btn-sm usage-back" onClick={onBack}>
              ‹ 返回
            </button>
            <h2 className="usage-title">使用统计</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={refresh}
            disabled={loading || refreshing}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>

        {loading ? (
          <div className="usage-state">正在研墨备纸…</div>
        ) : error && !dashboard ? (
          <div className="usage-state" role="alert">
            <span>统计数据没取到:{error}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>
              再试一次
            </button>
          </div>
        ) : dashboard ? (
          <>
            {error && (
              <div className="usage-empty-tip" role="alert">
                刷新没成功,先显示上一份旧数据:{error}
              </div>
            )}
            {!dashboard.hasData && (
              <div className="usage-empty-tip">
                和小柊聊几句,这里就会有你的用量足迹。
              </div>
            )}
            <UsageOverviewCards overview={dashboard.overview} />
            <TokenHeatmap activity={dashboard.activity} />
            <TokenTrendChart trend={dashboard.trend} colorMap={colorMap} />
            <ModelDonutChart models={dashboard.models} colorMap={colorMap} />
            {/* 派活用量(批 2b,PLAN §9.3):runs 为空整区隐藏,不加空状态文案 */}
            {dashboard.delegations.runs.length > 0 && (
              <DelegationUsageSection delegations={dashboard.delegations} />
            )}
            <div className="usage-foot muted">
              数据更新于 {new Date(dashboard.generatedAt).toLocaleString('zh-CN')} ·
              时区 {dashboard.timeZone} · 仅本地统计,不上传
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
