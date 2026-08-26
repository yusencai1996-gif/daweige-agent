import type { RoleDraft } from './role-draft-parser'

/**
 * 守则草稿卡(0.3.0 批 2b,PLAN §10.5):小柊消息里 `daweige-role-draft` 块的卡片呈现。
 *
 * 铁律:AI 绝不直接落守则文件——本卡只负责「打开既有界面并本地预填」:
 * - targetRoleId 存在 → 「过目并保存」打开 RoleRulesView,用户点保存才发 role:updateGuardrails;
 * - 无 targetRoleId(新角色) → 「用这个草稿建角色」打开 RoleCreateWizard,
 *   用户仍必须选文件夹/模板并在最终页确认。
 * 卡片自身不发任何写 IPC。
 */
export interface GuardrailsDraftCardActions {
  /** targetRoleId 对应的角色现名(角色可能已改名/删除;找不到返回 undefined)。 */
  readonly roleNameFor: (roleId: string) => string | undefined
  /** 「过目并保存」:打开既有守则编辑页并预填草稿(由 App/controller 接线)。 */
  readonly onReviewSave: (draft: RoleDraft) => void
  /** 「用这个草稿建角色」:打开新建向导并预填名字/守则。 */
  readonly onCreateWith: (draft: RoleDraft) => void
}

interface GuardrailsDraftCardProps {
  readonly draft: RoleDraft
  readonly actions: GuardrailsDraftCardActions
}

export function GuardrailsDraftCard({ draft, actions }: GuardrailsDraftCardProps) {
  const targetName =
    draft.targetRoleId !== null ? actions.roleNameFor(draft.targetRoleId) : undefined
  const forExisting = draft.targetRoleId !== null && targetName !== undefined

  return (
    <section className="draft-card" aria-label={`守则草稿:${draft.displayName}`}>
      <div className="draft-card-head">
        <span className="draft-card-seal" aria-hidden="true">
          草稿
        </span>
        <span className="draft-card-title">守则草稿</span>
        <span className="muted draft-card-for">
          {forExisting ? `给「${targetName}」` : `新伙伴「${draft.displayName}」`}
        </span>
      </div>
      <pre className="draft-card-preview">{draft.guardrails}</pre>
      <div className="draft-card-actions">
        {forExisting ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => actions.onReviewSave(draft)}
          >
            过目并保存
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => actions.onCreateWith(draft)}
          >
            用这个草稿建角色
          </button>
        )}
      </div>
      <div className="draft-card-hint muted">
        小柊只起草,不落笔:你打开看过、亲手点保存/确认,守则才会写进去。
      </div>
    </section>
  )
}
