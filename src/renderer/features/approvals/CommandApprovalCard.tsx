import { useState } from 'react'
import type { ApprovalDecision } from '../../../shared/domain'
import type { CommandApprovalRequest } from '../../../shared/domain/command'
import type { ApprovalCardState, ApprovalPhase } from '../../app/use-app-controller'

interface CommandApprovalCardProps {
  readonly card: ApprovalCardState
  readonly onRespond: (card: ApprovalCardState, decision: ApprovalDecision, note: string) => void
}

function commandStatusText(phase: ApprovalPhase): string {
  switch (phase) {
    case 'pending':
      return '等你拿主意'
    case 'running':
      return '执行中…'
    case 'succeeded':
      return '跑完了'
    case 'rejected':
      return '没运行'
    case 'failed':
      return '没跑成'
  }
}

/**
 * C4 命令确认卡(0.4.0 沙箱门面):命令原文等宽不改写不折断(横向滚动),
 * 沙箱权限如实标注(读全盘/写仅授权根/本版未隔离网络),三按钮语义对齐契约
 * ApprovalDecision:只运行这一次 / 本会话允许这条相同命令 / 不运行(可附言)。
 */
export function CommandApprovalCard({ card, onRespond }: CommandApprovalCardProps) {
  const request = card.request as CommandApprovalRequest
  const { phase } = card
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const interactive = phase === 'pending' && !card.responded

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(request.command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板不可用就让用户手动选中复制,不出错弹层
    }
  }

  return (
    <section className="approval-card command-approval-card" aria-label={`确认操作:${request.title}`}>
      <div className="approval-status-line" role="status">
        <span className={`status-dot ${phase}`} aria-hidden="true" />
        <span>{commandStatusText(phase)}</span>
      </div>

      <div className="approval-title">{request.title}</div>
      <div className="approval-desc">{request.description}</div>

      <div className="approval-command-wrap">
        <pre className="approval-command" tabIndex={0}>
          <code>{request.command}</code>
        </pre>
        <button
          type="button"
          className="btn btn-ghost btn-sm approval-command-copy"
          onClick={() => void copyCommand()}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>

      <div className="approval-meta">
        <span>在哪跑:{request.cwd}</span>
        <span>超时 {Math.round(request.timeoutMs / 1000)} 秒,到点自动停</span>
        <span>能读:整台电脑的文件(只读)</span>
        <span>
          能写{request.sandbox.writableRoots.length > 1 ? '(仅这些文件夹)' : ':'}
          {request.sandbox.writableRoots.length > 1 ? (
            <ul className="approval-paths">
              {request.sandbox.writableRoots.map((root) => (
                <li key={root}>{root}</li>
              ))}
            </ul>
          ) : (
            request.sandbox.writableRoots[0]
          )}
        </span>
      </div>

      {request.sandbox.network === 'not-isolated' && (
        <div className="command-net-note" role="note">
          本版未隔离网络:这条命令可以访问网络,拿不准来源就别放行。
        </div>
      )}

      {phase === 'pending' && (
        <>
          {request.reason !== '' && <div className="approval-reason">为什么问你:{request.reason}</div>}
          <div className="approval-note">
            <input
              type="text"
              className="text-input"
              value={note}
              maxLength={200}
              placeholder="拒绝时给它留句话(可选)"
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
              只运行这一次
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="本会话内这条一模一样的命令不再逐次询问"
              disabled={!interactive}
              onClick={() => onRespond(card, 'approve-session', note)}
            >
              本会话允许这条相同命令
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!interactive}
              onClick={() => onRespond(card, 'reject', note)}
            >
              不运行
            </button>
            {card.responded && <span className="muted">已收到,等它动手…</span>}
          </div>
        </>
      )}

      {phase === 'succeeded' && <div className="approval-result">命令跑完了,过程在对话里。</div>}
      {phase === 'rejected' && (
        <div className="approval-result">
          没运行。
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
