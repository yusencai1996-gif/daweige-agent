import { useEffect, useRef, useState } from 'react'
import type { RoleDetail } from '../../../shared/domain'
import type { SaveGuardrailsResult } from '../../app/use-app-controller'
import { countCodePoints } from './count-chars'

/**
 * 守则编辑整页(MainPane):加载 role:get → textarea 编辑 → 带 expectedVersion 保存。
 * 保存后从下一条消息开始生效;版本冲突时先提示、再由 controller 重拉覆盖。
 * 未保存修改:返回和「从侧栏切另一角色守则页」都要二次确认(后者由 App 挂起切换)。
 * 批 2b(PLAN §10.5):守则草稿卡「过目并保存」带 prefill 进来——只本地预填,
 * 用户亲手点保存才走 onSave(role:updateGuardrails),预填本身不发任何写 IPC。
 */

const GUARDRAILS_RECOMMEND = 2000
const GUARDRAILS_MAX = 6000

interface RoleRulesViewProps {
  readonly detail: RoleDetail | null
  readonly loading: boolean
  /** 守则草稿预填(批 2b):非 null 时,首次加载完成后填进编辑框;普通「编辑守则」恒为 null。 */
  readonly prefill: string | null
  readonly onSave: (guardrails: string) => Promise<SaveGuardrailsResult>
  readonly onBack: () => void
  /** 草稿脏状态上报(App 用来拦「切另一角色守则页」)。 */
  readonly onDirtyChange: (dirty: boolean) => void
  /** 有挂起的切换目标(侧栏点了别的角色的「编辑守则」且当前有未保存修改)。 */
  readonly switchPending: boolean
  readonly onConfirmSwitch: () => void
  readonly onCancelSwitch: () => void
}

export function RoleRulesView({
  detail,
  loading,
  prefill,
  onSave,
  onBack,
  onDirtyChange,
  switchPending,
  onConfirmSwitch,
  onCancelSwitch,
}: RoleRulesViewProps) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  /** 草稿预填只应用一次(本次打开);之后的版本冲突重拉仍以服务端正文为准,不回冲用户编辑。 */
  const prefillAppliedRef = useRef(false)

  // detail 加载完成/版本冲突重拉后,同步草稿(冲突场景:提示已在 notice 给出,这里直接覆盖)
  const detailKey = detail ? `${detail.summary.id}:${detail.guardrailsVersion}` : null
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  useEffect(() => {
    if (detail !== null && detailKey !== loadedKey) {
      const usePrefill = !prefillAppliedRef.current && prefill !== null
      prefillAppliedRef.current = true
      setDraft(usePrefill ? prefill : detail.guardrails)
      setLoadedKey(detailKey)
      setConfirmLeave(false)
    }
  }, [detail, detailKey, loadedKey, prefill])

  const dirty = detail !== null && draft !== detail.guardrails
  // 码点口径(S-03):与后端 checkGuardrails 一致,emoji 不会被多数一倍
  const len = countCodePoints(draft)

  // 脏状态上报给 App(切角色守则页二次确认用)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const requestBack = () => {
    if (dirty && !confirmLeave) {
      setConfirmLeave(true)
      return
    }
    onBack()
  }

  const save = async () => {
    if (saving || detail === null) return
    setSaving(true)
    try {
      await onSave(draft)
      // saved/conflict 后 detail 更新,useEffect 会重置 draft;error 时保留用户输入
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rules-pane">
      <div className="rules-header">
        <div className="rules-header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={requestBack}>
            ‹ 返回
          </button>
          <div>
            <h2 className="rules-title">
              {detail ? `${detail.summary.displayName} 的守则` : '角色守则'}
            </h2>
            {detail && (
              <div className="rules-sub muted">
                {detail.profile.personaSummary || detail.profile.templateId} ·
                保存后,从下一条消息开始生效
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={saving || detail === null || !dirty}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {switchPending && (
        <div className="rules-leave-confirm" role="alert">
          <span>有还没保存的修改,确定切到另一位伙伴的守则吗?</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={onConfirmSwitch}>
            切过去
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelSwitch}>
            继续编辑
          </button>
        </div>
      )}

      {confirmLeave && (
        <div className="rules-leave-confirm" role="alert">
          <span>有还没保存的修改,确定离开吗?</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={onBack}>
            离开
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirmLeave(false)}
          >
            继续编辑
          </button>
        </div>
      )}

      {loading || detail === null ? (
        <div className="rules-body muted">正在读守则…</div>
      ) : (
        <div className="rules-body">
          {/* 不设 maxLength:HTML 按 UTF-16 码元截断,与码点口径冲突(S-03);超长靠下方提示 + 后端拒绝 */}
          <textarea
            className="text-input rules-textarea"
            value={draft}
            aria-label="角色守则"
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value)
              setConfirmLeave(false)
            }}
          />
          <div className="rules-count muted">
            {len} / 推荐 {GUARDRAILS_RECOMMEND} / 上限 {GUARDRAILS_MAX}
          </div>
          {len > GUARDRAILS_RECOMMEND && (
            <div className="rules-hint muted">守则越长,占用上下文越多。</div>
          )}
          {len >= GUARDRAILS_MAX && (
            <div className="rules-hint">守则最多 {GUARDRAILS_MAX} 字,已经写满了。</div>
          )}
        </div>
      )}
    </div>
  )
}
