import { useEffect, useState } from 'react'
import type {
  AgentRunDetail,
  AgentRunStatus,
  AgentRunSummary,
  AgentRunUsage,
  DelegationApprovalRequest,
} from '../../../shared/domain'
import { formatTokens, formatTokensFull } from '../usage/usage-format'

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

/** 失败/拒绝/中断的原因行文案。 */
function failureText(run: AgentRunSummary): string {
  if (run.status === 'rejected') return '你没点头,这活儿没派出去。'
  return run.failureMessage ?? (run.status === 'interrupted' ? '派活中途断掉了。' : '出了点问题。')
}

function usageTitle(usage: AgentRunUsage): string {
  return `输入 ${formatTokensFull(usage.inputTokens)} · 输出 ${formatTokensFull(usage.outputTokens)} · 缓存读 ${formatTokensFull(usage.cacheReadTokens)} · 缓存写 ${formatTokensFull(usage.cacheWriteTokens)} tokens`
}

interface DelegationCardProps {
  readonly run: AgentRunSummary
  readonly actions: DelegationCardActions
}

/**
 * 派活卡(0.3.0 批 2a,PLAN §10.2):小柊消息流里的 run 卡。
 * 固定字段:派给谁/任务简报/允许路径/状态/轮次/总 token;
 * 验收要点/分项 token/产物路径/越界记录收进「展开细节」(默认折叠,防消息流臃肿);
 * 「查看完整过程」(批 2b)点进整页只读详情 AgentRunDetailView(PLAN §10.3);
 * awaiting-approval 形态即确认卡,[同意派出]/[不派] 走 approval:respond;
 * 审批完成后靠 agent_run_updated 原位变状态卡,不插第二张。
 */
export function DelegationCard({ run, actions }: DelegationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const approval = actions.approvalFor(run.runId)
  const detail = actions.detailFor(run.runId)
  const detailLoading = actions.detailLoadingFor(run.runId)

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
          <div className="delegation-field">
            <span className="delegation-label">分项 token</span>
            <span className="muted" title={usageTitle(usage)}>
              输入 {formatTokens(usage.inputTokens)} · 输出 {formatTokens(usage.outputTokens)} ·
              缓存读 {formatTokens(usage.cacheReadTokens)} · 缓存写{' '}
              {formatTokens(usage.cacheWriteTokens)}
            </span>
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
