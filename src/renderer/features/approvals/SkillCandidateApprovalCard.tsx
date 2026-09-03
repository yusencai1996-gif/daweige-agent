import { useState } from 'react'
import type {
  ApprovalDecision,
  SkillCandidateApprovalRequest,
  SkillMarketCandidate,
} from '../../../shared/domain'
import type { ApprovalCardState, ApprovalPhase } from '../../app/use-app-controller'
import { candidateMetaLine, registryLabel } from './skill-display'

interface SkillCandidateApprovalCardProps {
  readonly card: ApprovalCardState
  readonly onRespond: (
    card: ApprovalCardState,
    decision: ApprovalDecision,
    note: string,
    selectedOptionId?: string,
  ) => void
}

function statusText(phase: ApprovalPhase): string {
  switch (phase) {
    case 'pending':
      return '等你拿主意'
    case 'running':
      return '执行中…'
    case 'succeeded':
      return '已按你选的继续'
    case 'rejected':
      return '没装,按你说的来'
    case 'failed':
      return '没办成'
  }
}

interface CandidateRowProps {
  readonly requestId: string
  readonly candidate: SkillMarketCandidate
  readonly selected: boolean
  readonly interactive: boolean
  readonly onSelect: (optionId: string) => void
}

/** 单个候选:原生 radio 保证键盘可达(方向键在组内移动),整行可点。 */
function CandidateRow({ requestId, candidate, selected, interactive, onSelect }: CandidateRowProps) {
  const metaLine = candidateMetaLine(candidate)
  return (
    <label className={`skill-candidate-option${selected ? ' selected' : ''}`}>
      <input
        type="radio"
        name={`skill-candidate-${requestId}`}
        checked={selected}
        disabled={!interactive}
        onChange={() => onSelect(candidate.optionId)}
      />
      <span className="skill-candidate-main">
        <span className="skill-candidate-head">
          <span className="skill-candidate-name">{candidate.displayName}</span>
          <span className="approval-badge">{registryLabel(candidate.registryId)}</span>
        </span>
        {candidate.summary !== '' && (
          <span className="skill-candidate-summary">{candidate.summary}</span>
        )}
        {metaLine !== '' && <span className="skill-candidate-meta">{metaLine}</span>}
      </span>
    </label>
  )
}

/**
 * 技能候选确认卡(0.7.0 A1):搜到的 1~8 个技能候选单选。
 * 铁律:无默认选中,「选这个」必须用户亲手点中一个候选才可用;拒绝随时可点;
 * 没有「本次会话全部允许」(契约禁 approve-session,后端 fail-closed);
 * 批准回传的是候选数据自带的 opaque optionId,前端不构造 slug/URL。
 */
export function SkillCandidateApprovalCard({ card, onRespond }: SkillCandidateApprovalCardProps) {
  const request = card.request as SkillCandidateApprovalRequest
  const { phase } = card
  const [note, setNote] = useState('')
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const interactive = phase === 'pending' && !card.responded
  const selectedCandidate =
    selectedOptionId === null
      ? undefined
      : request.candidates.find((candidate) => candidate.optionId === selectedOptionId)

  return (
    <section className="approval-card skill-approval-card" aria-label={`确认操作:${request.title}`}>
      <div className="approval-status-line" role="status">
        <span className={`status-dot ${phase}`} aria-hidden="true" />
        <span>{statusText(phase)}</span>
      </div>

      <div className="approval-title">{request.title}</div>
      <div className="approval-desc">{request.description}</div>

      <div className="approval-meta">
        <span>搜索词:{request.query}</span>
        <span>选中后还会给你看技能正文预览,确认无误才真正安装。</span>
      </div>

      <div className="skill-candidate-list" role="radiogroup" aria-label="搜到的技能候选">
        {request.candidates.map((candidate) => (
          <CandidateRow
            key={candidate.optionId}
            requestId={request.id}
            candidate={candidate}
            selected={candidate.optionId === selectedOptionId}
            interactive={interactive}
            onSelect={setSelectedOptionId}
          />
        ))}
      </div>

      {phase === 'pending' && (
        <>
          <div className="approval-note">
            <input
              type="text"
              className="text-input"
              value={note}
              maxLength={200}
              placeholder="都不合适的话,可以留句话告诉它想要什么"
              aria-label="拒绝时给它留句话(可选)"
              disabled={!interactive}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!interactive || selectedCandidate === undefined}
              title={selectedCandidate === undefined ? '先在上面点中一个候选' : undefined}
              onClick={() =>
                selectedCandidate !== undefined &&
                onRespond(card, 'approve', note, selectedCandidate.optionId)
              }
            >
              选这个
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!interactive}
              onClick={() => onRespond(card, 'reject', note)}
            >
              都不合适
            </button>
            {card.responded && <span className="muted">已收到,等它动手…</span>}
          </div>
        </>
      )}

      {phase === 'succeeded' && <div className="approval-result">已按你的选择继续。</div>}
      {phase === 'rejected' && (
        <div className="approval-result">
          没装任何技能。
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
