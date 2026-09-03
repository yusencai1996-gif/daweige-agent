import { useState } from 'react'
import type { ApprovalDecision, SkillInstallApprovalRequest } from '../../../shared/domain'
import type { ApprovalCardState, ApprovalPhase } from '../../app/use-app-controller'
import { candidateMetaLine, humanizeSkillLocation, registryLabel } from './skill-display'
import { SkillMarkdownPreview } from './SkillMarkdownPreview'

interface SkillInstallApprovalCardProps {
  readonly card: ApprovalCardState
  readonly onRespond: (card: ApprovalCardState, decision: ApprovalDecision, note: string) => void
}

function statusText(phase: ApprovalPhase): string {
  switch (phase) {
    case 'pending':
      return '等你拿主意'
    case 'running':
      return '安装中…'
    case 'succeeded':
      return '装好了'
    case 'rejected':
      return '没装,按你说的来'
    case 'failed':
      return '没装成'
  }
}

/**
 * 技能安装预览卡(0.7.0 A2):来源/许可/目标逻辑位置 + 完整打码 Markdown 预览。
 * 目标位置渲染成人话「全局技能 / <name>」,不透出 URI 原文;
 * 只有本次批准/拒绝,没有「本次会话全部允许」(契约禁 approve-session)。
 */
export function SkillInstallApprovalCard({ card, onRespond }: SkillInstallApprovalCardProps) {
  const request = card.request as SkillInstallApprovalRequest
  const { phase } = card
  const [note, setNote] = useState('')
  const interactive = phase === 'pending' && !card.responded
  const candidate = request.candidate
  const metaLine = candidateMetaLine(candidate)
  const locationLabel = humanizeSkillLocation(request.targetLogicalLocation) ?? '全局技能目录'

  return (
    <section className="approval-card skill-approval-card" aria-label={`确认操作:${request.title}`}>
      <div className="approval-status-line" role="status">
        <span className={`status-dot ${phase}`} aria-hidden="true" />
        <span>{statusText(phase)}</span>
      </div>

      <div className="approval-title">{request.title}</div>
      <div className="approval-desc">{request.description}</div>

      <div className="skill-install-source">
        <span className="skill-candidate-head">
          <span className="skill-candidate-name">{candidate.displayName}</span>
          <span className="approval-badge">{registryLabel(candidate.registryId)}</span>
        </span>
        {candidate.summary !== '' && (
          <span className="skill-candidate-summary">{candidate.summary}</span>
        )}
        {metaLine !== '' && <span className="skill-candidate-meta">{metaLine}</span>}
      </div>

      <div className="approval-meta">
        <span>装到:{locationLabel}</span>
        <span>只装纯文字技能,不带任何脚本;装好后新建对话生效。</span>
      </div>

      <SkillMarkdownPreview
        content={request.markdownPreview}
        totalBytes={request.markdownBytes}
        truncated={request.previewTruncated}
      />

      {phase === 'pending' && (
        <>
          <div className="approval-note">
            <input
              type="text"
              className="text-input"
              value={note}
              maxLength={200}
              placeholder="不想装的话,可以留句话告诉它"
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
              装它
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!interactive}
              onClick={() => onRespond(card, 'reject', note)}
            >
              先别装
            </button>
            {card.responded && <span className="muted">已收到,等它动手…</span>}
          </div>
        </>
      )}

      {phase === 'succeeded' && (
        <div className="approval-result">装好了,新建对话后就能用。</div>
      )}
      {phase === 'rejected' && (
        <div className="approval-result">
          没装。
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
