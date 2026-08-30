import { useEffect, useState } from 'react'
import type {
  AgentRunDetail,
  AgentRunInterruptSource,
  AgentRunQueueReason,
  AgentRunStatus,
  AgentRunSummary,
  AgentRunUsage,
  DelegationApprovalRequest,
} from '../../../shared/domain'
import { formatTokens, formatTokensFull } from '../usage/usage-format'
import { TokenSegmentBar } from './TokenSegmentBar'

/** 派活确认(delegation)的前端状态:请求本体 + 是否已回过一次(防重复点击)。 */
export interface DelegationApprovalState {
  readonly request: DelegationApprovalRequest
  readonly responded: boolean
}

/** DelegationCard 需要的全部外部动作,由 controller 汇总成稳定对象一路传下来。 */
export interface DelegationCardActions {
  readonly approvalFor: (runId: string) => DelegationApprovalState | undefined
  readonly detailFor: (runId: string) => AgentRunDetail | undefined
  readonly detailLoadingFor: (runId: string) => boolean
  readonly onLoadDetail: (runId: string) => void
  /** 批 2b:[查看完整过程] 升级为整页只读详情(PLAN §10.3),替换批 2a 的卡内内联展开。 */
  readonly onOpenFullDetail: (runId: string) => void
  /** approve=同意派出 / reject=不派;delegation 不吃任何会话级授权,只有这两个决定。 */
  readonly onRespond: (request: DelegationApprovalRequest, decision: 'approve' | 'reject') => void
  /**
   * 协作链(0.4.0 D):同一条 graph 上的已知 run 摘要(含自身),按 createdAt 谱序。
   * 单节点链返回长度 ≤1 的数组——卡头链摘要行与浮层都以它判空收敛,不渲染多余 UI。
   */
  readonly chainPeersFor: (graphId: string) => readonly AgentRunSummary[]
  /** 打断(0.4.0 D):在途请求防重(busy 时按钮禁用);错误由 controller 人话提示。 */
  readonly interruptBusyFor: (runId: string) => boolean
  /** 确认文案点过「确定打断」后才调;controller 内部发 agentRun:interrupt。 */
  readonly onInterrupt: (runId: string) => void
}

export interface StatusInfo {
  readonly text: string
  /** pending=等用户(accent)/active=进行中(墨色呼吸)/done=完成/muted=未派出/failed=朱砂。 */
  readonly tone: 'pending' | 'active' | 'done' | 'muted' | 'failed'
}

/** 八态状态行文案,全中文说人话(PLAN §7.3/§10.2);整页详情(批 2b)复用同一份。 */
export function statusInfo(run: AgentRunSummary): StatusInfo {
  const name = run.targetRoleName
  switch (run.status) {
    case 'awaiting-approval':
      return { text: `等你点头:要不要派给${name}`, tone: 'pending' }
    case 'queued':
    case 'running':
      return { text: `${name}正在干活`, tone: 'active' }
    case 'waiting':
      return run.waitingReason === 'user-approval'
        ? { text: `等你确认:${name}要动文件了`, tone: 'pending' }
        : { text: `${name}正在干活 · 小柊正在等候`, tone: 'active' }
    case 'completed':
      return { text: `${name}干完了`, tone: 'done' }
    case 'failed':
      return { text: `${name}没办成`, tone: 'failed' }
    case 'rejected':
      return { text: '未派出', tone: 'muted' }
    case 'interrupted':
      return { text: '已中断', tone: 'failed' }
  }
}

/** failed/rejected/interrupted 用克制暗朱砂边线(不整卡警报红)。 */
function isFailureStatus(status: AgentRunStatus): boolean {
  return status === 'failed' || status === 'rejected' || status === 'interrupted'
}

/** 终态=不再有后续动作(completed/failed/rejected/interrupted);打断按钮只对非终态出场。 */
export function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected' || status === 'interrupted'
}

/** 排队原因人话(0.4.0 D);仅 queued 态非空,null 不出提示行。 */
export function queueReasonText(reason: AgentRunQueueReason): string | null {
  switch (reason) {
    case 'dependency':
      return '排队中:前面的活儿还没干完'
    case 'workspace-lock':
      return '排队中:工作文件夹正被占着'
    case 'concurrency-limit':
      return '排队中:一起开工的伙伴满了'
    default:
      return null
  }
}

/** 打断来源短标签(0.4.0 D);app-restart 照实说,不伪装成用户打断。 */
export function interruptSourceLabel(source: AgentRunInterruptSource): string | null {
  switch (source) {
    case 'user':
      return '用户打断'
    case 'manager':
      return '小柊收回'
    case 'app-restart':
      return '应用重启'
    default:
      return null
  }
}

/** 节点/链摘要用的状态短语(statusInfo 求全,这里求短——塞得进小徽标)。 */
export function shortStatusText(run: AgentRunSummary): string {
  switch (run.status) {
    case 'awaiting-approval':
      return '等你点头'
    case 'queued':
      return '排队中'
    case 'running':
      return '干活中'
    case 'waiting':
      return run.waitingReason === 'user-approval' ? '等你确认' : '等候中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '没办成'
    case 'rejected':
      return '未派出'
    case 'interrupted':
      return '已中断'
  }
}

/** 失败/拒绝/中断的原因行文案;interrupted 追加打断来源人话(0.4.0 D)。 */
function failureText(run: AgentRunSummary): string {
  if (run.status === 'rejected') return '你没点头,这活儿没派出去。'
  if (run.status === 'interrupted') {
    const base = run.failureMessage ?? '派活中途断掉了。'
    const source = interruptSourceLabel(run.interruptSource)
    return source !== null ? `${base}(打断来源:${source})` : base
  }
  return run.failureMessage ?? '出了点问题。'
}

function usageTitle(usage: AgentRunUsage): string {
  return `输入 ${formatTokensFull(usage.inputTokens)} · 输出 ${formatTokensFull(usage.outputTokens)} · 缓存读 ${formatTokensFull(usage.cacheReadTokens)} · 缓存写 ${formatTokensFull(usage.cacheWriteTokens)} tokens`
}

/** 「进行中」= 占着链路等结果的状态;completed 与终态折损各算各(链摘要口径)。 */
const ACTIVE_STATUSES: readonly AgentRunStatus[] = [
  'awaiting-approval',
  'queued',
  'running',
  'waiting',
]

interface InterruptControlProps {
  readonly run: AgentRunSummary
  readonly busy: boolean
  readonly onInterrupt: (runId: string) => void
}

/**
 * 打断入口(0.4.0 D):非终态 run 才出场;先出确认文案再动手,
 * 防手滑废掉一次还在干的活。状态被 agent_run_updated 推到终态后自动收回。
 */
export function InterruptControl({ run, busy, onInterrupt }: InterruptControlProps) {
  const [armed, setArmed] = useState(false)

  // 状态翻终态(推送校正到达)时拆掉待确认行,不留悬空的确认文案
  useEffect(() => {
    if (isTerminalStatus(run.status)) setArmed(false)
  }, [run.status])

  if (isTerminalStatus(run.status)) return null
  if (!armed) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-interrupt"
        disabled={busy}
        onClick={() => setArmed(true)}
      >
        {busy ? '正在打断…' : '打断'}
      </button>
    )
  }
  return (
    <div className="delegation-interrupt-confirm" role="group" aria-label="打断确认">
      <span className="delegation-interrupt-text">
        确定打断?已完成的产出保留,未完成的不再继续
      </span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busy}
        onClick={() => {
          setArmed(false)
          onInterrupt(run.runId)
        }}
      >
        {busy ? '正在打断…' : '确定打断'}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => setArmed(false)}
      >
        先不打
      </button>
    </div>
  )
}

interface DelegationCardProps {
  readonly run: AgentRunSummary
  readonly actions: DelegationCardActions
}

/**
 * 派活卡(0.3.0 批 2a,PLAN §10.2):小柊消息流里的 run 卡。
 * 固定字段:派给谁/任务简报/允许路径/状态/轮次/总 token;
 * 验收要点/分项 token/产物路径/越界记录收进「展开细节」(默认折叠,防消息流臃肿);
 * 「查看完整过程」(0.5.0 第三批 A-28 收编)打开协作链面板详情态并 pin 这条 run 的 tab;
 * awaiting-approval 形态即确认卡,[同意派出]/[不派] 走 approval:respond;
 * 审批完成后靠 agent_run_updated 原位变状态卡,不插第二张。
 */
export function DelegationCard({ run, actions }: DelegationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [chainOpen, setChainOpen] = useState(false)
  const approval = actions.approvalFor(run.runId)
  const detail = actions.detailFor(run.runId)
  const detailLoading = actions.detailLoadingFor(run.runId)
  /** 同链已知 run(含自身);长度 ≤1 说明是单节点链,不渲染链摘要(0.3 旧数据行为不变)。 */
  const chainPeers = actions.chainPeersFor(run.graphId)

  // 完成态要显示结论摘要在 detail 里,卡片一出现就取(loadRunDetail 内部去重)
  useEffect(() => {
    if (run.status === 'completed' && detail === undefined) actions.onLoadDetail(run.runId)
  }, [run.status, run.runId, detail, actions])

  const toggleExpanded = () => {
    if (!expanded && detail === undefined) actions.onLoadDetail(run.runId)
    setExpanded((v) => !v)
  }

  const info = statusInfo(run)
  const { usage } = run
  const hasUsage = usage.rounds > 0 || usage.totalTokens > 0
  // 验收要点:awaiting 时优先用确认卡请求里的(详情可能还没拉),其余看详情信封
  const criteria =
    run.status === 'awaiting-approval'
      ? (approval?.request.acceptanceCriteria ?? detail?.envelope.acceptanceCriteria ?? [])
      : (detail?.envelope.acceptanceCriteria ?? [])

  return (
    <section
      className={`delegation-card${isFailureStatus(run.status) ? ' is-failed' : ''}`}
      aria-label={`派活卡:${info.text}`}
    >
      <div className="delegation-status" role="status">
        <span className={`delegation-dot ${info.tone}`} aria-hidden="true" />
        <span>{info.text}</span>
        {chainPeers.length > 1 && (
          <span className="delegation-chain">
            <button
              type="button"
              className="btn btn-ghost btn-sm delegation-chain-btn"
              aria-expanded={chainOpen}
              onClick={() => setChainOpen((v) => !v)}
            >
              协作链 {chainPeers.length} 节点 ·{' '}
              {chainPeers.filter((p) => ACTIVE_STATUSES.includes(p.status)).length} 进行中 ·{' '}
              {chainPeers.filter((p) => p.status === 'completed').length} 完成
            </button>
            {chainOpen && (
              <ul className="delegation-chain-pop">
                {chainPeers.map((peer) => (
                  <li
                    key={peer.runId}
                    className={`delegation-chain-item${peer.runId === run.runId ? ' is-current' : ''}`}
                  >
                    <span className={`delegation-dot ${statusInfo(peer).tone}`} aria-hidden="true" />
                    <span className="delegation-chain-name">{peer.targetRoleName}</span>
                    <span className="muted">{shortStatusText(peer)}</span>
                    {peer.followupCount > 0 && (
                      <span className="muted">追加 {peer.followupCount} 次</span>
                    )}
                    {peer.runId === run.runId && (
                      <span className="delegation-chain-cur">这张卡</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </span>
        )}
      </div>

      <div className="delegation-fields">
        <div className="delegation-field">
          <span className="delegation-label">派给</span>
          <span>{run.targetRoleName}</span>
        </div>
        <div className="delegation-field">
          <span className="delegation-label">任务</span>
          <span className="delegation-brief" title={run.taskBrief}>
            {run.taskBrief}
          </span>
        </div>
        <div className="delegation-field">
          <span className="delegation-label">允许操作</span>
          <ul className="delegation-paths">
            {run.allowedWorkspacePaths.map((path) => (
              <li key={path} title={path}>
                {path}
              </li>
            ))}
          </ul>
        </div>
        {hasUsage && (
          <div className="delegation-field">
            <span className="delegation-label">用量</span>
            <span className="muted" title={usageTitle(usage)}>
              轮次 {usage.rounds} · 总 token {formatTokens(usage.totalTokens)}
            </span>
          </div>
        )}
      </div>

      {run.status === 'awaiting-approval' &&
        (approval !== undefined ? (
          <>
            {criteria.length > 0 && (
              <div className="delegation-field">
                <span className="delegation-label">验收</span>
                <ul className="delegation-criteria">
                  {criteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="delegation-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={approval.responded}
                onClick={() => actions.onRespond(approval.request, 'approve')}
              >
                同意派出
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={approval.responded}
                onClick={() => actions.onRespond(approval.request, 'reject')}
              >
                不派
              </button>
              {approval.responded && <span className="muted">已收到,等小柊安排…</span>}
            </div>
          </>
        ) : (
          <div className="delegation-hint">确认信息还没到,稍等片刻。</div>
        ))}

      {run.status === 'waiting' && run.waitingReason === 'user-approval' && (
        <div className="delegation-hint">文件确认卡在下方输入区上面,处理完它就继续。</div>
      )}

      {run.status === 'completed' && (
        <div className="delegation-summary">
          {detail === undefined
            ? detailLoading
              ? '正在取结论…'
              : ''
            : detail.result !== null
              ? detail.result.summary
              : '这次没留下结论摘要。'}
        </div>
      )}

      {isFailureStatus(run.status) && <div className="delegation-hint">{failureText(run)}</div>}

      {/* 打断入口(0.4.0 D):非终态 run 出场;终态由 InterruptControl 自行收敛为 null */}
      <InterruptControl
        run={run}
        busy={actions.interruptBusyFor(run.runId)}
        onInterrupt={actions.onInterrupt}
      />

      <div className="delegation-toggles">
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggleExpanded}>
          {expanded ? '收起细节' : '展开细节'}
        </button>
        {run.internalSessionId !== null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => actions.onOpenFullDetail(run.runId)}
          >
            查看完整过程
          </button>
        )}
      </div>

      {expanded && (
        <div className="delegation-detail">
          {/* 分项 token(A-25):纯文字四项升级为分段横条图;卡面「轮次 X · 总 token Y」小字不动 */}
          <div className="delegation-field">
            <span className="delegation-label">分项 token</span>
            <TokenSegmentBar usage={usage} />
          </div>
          {detail === undefined ? (
            <div className="delegation-hint">
              {detailLoading ? '正在取细节…' : '细节没取到,再点一次试试。'}
            </div>
          ) : (
            <>
              <div className="delegation-field">
                <span className="delegation-label">验收要点</span>
                {criteria.length > 0 ? (
                  <ul className="delegation-criteria">
                    {criteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">没有写验收要点</span>
                )}
              </div>
              <div className="delegation-field">
                <span className="delegation-label">产物路径</span>
                {detail.result !== null && detail.result.artifactPaths.length > 0 ? (
                  <ul className="delegation-artifacts">
                    {detail.result.artifactPaths.map((path) => (
                      <li key={path} title={path}>
                        {path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">没有产物文件</span>
                )}
              </div>
              {/* 数据明细(A-19):产出中下游要核对的关键数字/条目;没写就整个字段不出场 */}
              {detail.result?.detailData != null && detail.result.detailData.trim() !== '' && (
                <div className="delegation-field">
                  <span className="delegation-label">数据明细</span>
                  <span className="delegation-detail-data">{detail.result.detailData}</span>
                </div>
              )}
              <div className="delegation-field">
                <span className="delegation-label">越界记录</span>
                {detail.result !== null && detail.result.boundaryViolations.length > 0 ? (
                  <ul className="delegation-artifacts">
                    {detail.result.boundaryViolations.map((v) => (
                      <li key={`${v.path}-${v.occurredAt}`} title={v.path}>
                        {v.operation === 'read' ? '读了' : '写了'} {v.path}——{v.reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">没有越界</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
