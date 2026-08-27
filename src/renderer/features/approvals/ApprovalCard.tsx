import { useState } from 'react'
import type { ApprovalDecision, FileApprovalRequest } from '../../../shared/domain'
import type { ApprovalCardState, ApprovalPhase } from '../../app/use-app-controller'

interface ApprovalCardProps {
  readonly card: ApprovalCardState
  readonly onRespond: (card: ApprovalCardState, decision: ApprovalDecision, note: string) => void
}

/** 批准按钮说清按下会发生什么,按操作类型给词。 */
function approveLabel(kind: FileApprovalRequest['kind'], recoverable: boolean): string {
  switch (kind) {
    case 'write':
      return '写进去'
    case 'edit':
      return '改它'
    case 'move':
      return '移过去'
    case 'rename':
      return '改名'
    case 'delete':
      return recoverable ? '删掉(能恢复)' : '删掉'
    case 'mkdir':
      return '建文件夹'
    case 'outside-read':
      return '读吧'
    case 'role-rules-edit':
      return '改守则'
  }
}

function statusText(phase: ApprovalPhase): string {
  switch (phase) {
    case 'pending':
      return '等你拿主意'
    case 'running':
      return '执行中…'
    case 'succeeded':
      return '办好了'
    case 'rejected':
      return '没动,按你说的来'
    case 'failed':
      return '没办成'
  }
}

/**
 * 确认卡片:pending → running → succeeded / rejected / failed。
 * 问句直接问人;按钮写清后果;拒绝分支始终保留可选单行附言;不显示代码 diff。
 */
export function ApprovalCard({ card, onRespond }: ApprovalCardProps) {
  const { request, phase } = card
  const [note, setNote] = useState('')
  const interactive = phase === 'pending' && !card.responded
  const isCommand = request.kind === 'command'
  // command(0.4.0 C)最小过渡:C4 换 CommandApprovalCard 专用渲染;
  // 这里先展示通用字段+命令原文,不给会话级授权(独立 CommandApprovalCache 语义)
  const fileRequest = isCommand ? undefined : request
  // 「本次会话全部允许」只对工作区内、非删除、有工具名的操作开放(A-01/A-03);
  // 守则修改(role-rules-edit)按契约永远逐次确认(PLAN §3.3),不给会话级授权。
  const canApproveSession =
    !isCommand &&
    fileRequest !== undefined &&
    fileRequest.toolName !== undefined &&
    fileRequest.kind !== 'delete' &&
    fileRequest.kind !== 'role-rules-edit' &&
    fileRequest.outsideWorkspace === false

  return (
    <section className="approval-card" aria-label={`确认操作:${request.title}`}>
      <div className="approval-status-line" role="status">
        <span className={`status-dot ${phase}`} aria-hidden="true" />
        <span>{statusText(phase)}</span>
      </div>

      <div className="approval-title">{request.title}</div>
      <div className="approval-desc">{request.description}</div>

      {isCommand ? (
        <div className="approval-meta">
          <code className="approval-command-text">{request.command}</code>
          <span>在 {request.cwd} 运行 · 超时 {Math.round(request.timeoutMs / 1000)} 秒</span>
        </div>
      ) : (
        fileRequest && (
          <>
            <div className="approval-meta">
              <span>一共 {fileRequest.itemCount} 项</span>
              {fileRequest.kind === 'delete' && (
                <span>{fileRequest.recoverable ? '删到回收站,后悔了能捞回来' : '彻底删除,捞不回来'}</span>
              )}
            </div>

            {fileRequest.samplePaths.length > 0 && (
              <ul className="approval-paths">
                {fileRequest.samplePaths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            )}

            {fileRequest.outsideWorkspace && (
              <div className="approval-outside">注意:这在你的工作文件夹外面。</div>
            )}
          </>
        )
      )}

      {phase === 'pending' && (
        <>
          <div className="approval-note">
            <input
              type="text"
              className="text-input"
              value={note}
              maxLength={200}
              placeholder="告诉它该怎么做"
              aria-label="拒绝时给它留句话(可选)"
              disabled={!interactive}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!interactive}
              onClick={() => onRespond(card, 'approve', note)}
            >
              {isCommand
                ? '只运行这一次'
                : approveLabel(fileRequest!.kind, fileRequest!.recoverable)}
            </button>
            {canApproveSession && (
              <button
                type="button"
                className="btn btn-ghost"
                title="本会话内同类操作不再逐个询问"
                disabled={!interactive}
                onClick={() => onRespond(card, 'approve-session', note)}
              >
                本次会话全部允许
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!interactive}
              onClick={() => onRespond(card, 'reject', note)}
            >
              先别动
            </button>
            {card.responded && <span className="muted">已收到,等它动手…</span>}
          </div>
        </>
      )}

      {phase === 'succeeded' && <div className="approval-result">已经按你批准的办完了。</div>}
      {phase === 'rejected' && (
        <div className="approval-result">
          没动任何东西。
          {card.note && <div className="approval-echo-note">你留的话:「{card.note}」已经转告它了。</div>}
        </div>
      )}
      {phase === 'failed' && (
        <div className="approval-result failed">
          出了点问题{card.error ? `:${card.error}` : '。'}
        </div>
      )}
      {phase === 'pending' && card.error && (
        <div className="approval-result failed">{card.error},请再点一次。</div>
      )}
    </section>
  )
}
