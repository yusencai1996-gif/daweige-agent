import { useEffect, useRef, useState } from 'react'
import type { RoleTemplate } from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { CreateRoleInput } from '../../app/use-app-controller'
import { countCodePoints } from './count-chars'

/**
 * 新建角色三步向导(overlay):起名 → 挂载工作文件夹 → 选人设并过目守则。
 * 只有最后一步「招他入伙」发起 role:create,中途取消不留半成品。
 * 批 2b(PLAN §10.5):守则草稿卡「用这个草稿建角色」带 prefill 进来——只预填
 * 名字/守则正文,文件夹仍要亲手选、人设仍要亲手点、最终仍要亲手确认。
 */

const GUARDRAILS_RECOMMEND = 2000
const GUARDRAILS_MAX = 6000

/** 路径末级目录名(展示用)。 */
function baseName(p: string): string {
  const normalized = p.replace(/[\\/]+$/g, '')
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

/** 挂载/路径类错误回到第 2 步提示,其余留在第 3 步。 */
function isMountError(message: string): boolean {
  return message.includes('文件夹') || message.includes('路径')
}

interface RoleCreateWizardProps {
  readonly bridge: DaweigeBridge
  /** 守则草稿预填(批 2b):名字与守则正文填好等用户过目;null/缺省 = 空白向导。 */
  readonly prefill?: { readonly displayName: string; readonly guardrails: string } | null
  readonly onCancel: () => void
  /** 返回 ok:false 时带人话消息,向导停在当前步不丢已填内容。 */
  readonly onSubmit: (input: CreateRoleInput) => Promise<{ readonly ok: boolean; readonly message?: string }>
}

type Step = 1 | 2 | 3

export function RoleCreateWizard({ bridge, prefill, onCancel, onSubmit }: RoleCreateWizardProps) {
  const [step, setStep] = useState<Step>(1)
  const [name, setName] = useState(prefill?.displayName ?? '')
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [templates, setTemplates] = useState<readonly RoleTemplate[] | null>(null)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<RoleTemplate['id'] | null>(null)
  const [guardrails, setGuardrails] = useState(prefill?.guardrails ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // 打开时聚焦;Esc 取消
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // 进入第 3 步才拉模板(一次)
  useEffect(() => {
    if (step !== 3 || templates !== null) return
    let alive = true
    bridge
      .invoke('role:listTemplates', undefined)
      .then((list) => {
        if (!alive) return
        setTemplates(list)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setTemplatesError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [bridge, step, templates])

  const nameTrimmed = name.trim()
  const nameOk = nameTrimmed.length >= 1 && nameTrimmed.length <= 24
  // 码点口径(S-03):与后端 checkGuardrails 一致,emoji 不会被多数一倍
  const guardrailsLen = countCodePoints(guardrails)

  const chooseWorkspace = async () => {
    setError(null)
    try {
      const chosen = await bridge.invoke('workspace:choose', undefined)
      // 取消选择:停在原地,不产生任何半成品
      if (chosen !== null) setWorkspace(chosen)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pickTemplate = (tpl: RoleTemplate) => {
    setTemplateId(tpl.id)
    // 草稿预填模式(批 2b):人设只定身份骨架,不覆盖小柊起草、用户已过目中的守则正文
    if (prefill == null) setGuardrails(tpl.guardrailsDraft)
  }

  const submit = async () => {
    if (!nameOk || workspace === null || templateId === null || submitting) return
    setSubmitting(true)
    setError(null)
    const result = await onSubmit({
      displayName: nameTrimmed,
      workspacePaths: [workspace],
      primaryWorkspacePath: workspace,
      templateId,
      guardrails,
    })
    setSubmitting(false)
    if (!result.ok) {
      const message = result.message ?? '创建失败,请重试'
      // 重复挂载/路径失效:回到第 2 步改文件夹,已填内容不丢
      if (isMountError(message)) {
        setStep(2)
        setError(message)
      } else {
        setError(message)
      }
    }
  }

  return (
    <div className="role-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="role-dialog wizard"
        role="dialog"
        aria-modal="true"
        aria-label="新建角色"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !submitting) onCancel()
        }}
      >
        <div className="role-dialog-head">
          <div className="role-dialog-title">招一位伙伴</div>
          <div className="wizard-steps" aria-label={`第 ${step} 步,共 3 步`}>
            <span className={step >= 1 ? 'wizard-dot on' : 'wizard-dot'} />
            <span className={step >= 2 ? 'wizard-dot on' : 'wizard-dot'} />
            <span className={step >= 3 ? 'wizard-dot on' : 'wizard-dot'} />
          </div>
        </div>

        {step === 1 && (
          <div className="wizard-body">
            <label className="wizard-label" htmlFor="wizard-name">
              给他起个名字
            </label>
            <input
              id="wizard-name"
              className="text-input"
              value={name}
              autoFocus
              maxLength={24}
              placeholder="比如:小编、账房、文件管家"
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameOk) {
                  e.preventDefault()
                  setStep(2)
                }
              }}
            />
            <div className="wizard-hint">1~24 字。显示名以后可改,内部档案不会变。</div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-body">
            <div className="wizard-label">给他挂一个工作文件夹</div>
            <div className="wizard-hint">他默认只在这个文件夹里干活;先选一个,以后再说加。</div>
            {workspace !== null ? (
              <div className="wizard-workspace">
                <div className="wizard-workspace-name">{baseName(workspace)}</div>
                <div className="wizard-workspace-path" title={workspace}>
                  {workspace}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void chooseWorkspace()}
                >
                  换一个
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void chooseWorkspace()}
              >
                选择文件夹…
              </button>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="wizard-body">
            <div className="wizard-label">选个人设,顺便过目他的守则</div>
            {templatesError !== null && (
              <div className="wizard-error" role="alert">
                {templatesError}
              </div>
            )}
            {templates === null && templatesError === null && (
              <div className="wizard-hint">正在准备人设模板…</div>
            )}
            {templates !== null && (
              <div className="wizard-templates">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className={templateId === tpl.id ? 'wizard-tpl selected' : 'wizard-tpl'}
                    aria-pressed={templateId === tpl.id}
                    onClick={() => pickTemplate(tpl)}
                  >
                    <span className="wizard-tpl-name">{tpl.name}</span>
                    <span className="wizard-tpl-desc">{tpl.description}</span>
                  </button>
                ))}
              </div>
            )}
            {/* 不设 maxLength:HTML 按 UTF-16 码元截断,与码点口径冲突(S-03);超长靠下方提示 + 后端拒绝 */}
            <textarea
              className="text-input wizard-guardrails"
              value={guardrails}
              aria-label="角色守则"
              placeholder="选中一个人设后,守则草稿会填在这里,可以直接改。"
              onChange={(e) => setGuardrails(e.target.value)}
            />
            <div className="wizard-count muted">
              {guardrailsLen} / 推荐 {GUARDRAILS_RECOMMEND} / 上限 {GUARDRAILS_MAX}
            </div>
            {guardrailsLen > GUARDRAILS_RECOMMEND && (
              <div className="wizard-hint">守则越长,占用上下文越多。</div>
            )}
            {guardrailsLen >= GUARDRAILS_MAX && (
              <div className="wizard-error" role="alert">
                守则最多 {GUARDRAILS_MAX} 字,已经写满了。
              </div>
            )}
          </div>
        )}

        {error !== null && (
          <div className="wizard-error" role="alert">
            {error}
          </div>
        )}

        <div className="role-dialog-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={submitting}
            onClick={onCancel}
          >
            取消
          </button>
          <span className="role-dialog-foot-gap" />
          {step > 1 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => {
                setError(null)
                setStep((step - 1) as Step)
              }}
            >
              上一步
            </button>
          )}
          {step < 3 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={(step === 1 && !nameOk) || (step === 2 && workspace === null)}
              onClick={() => {
                setError(null)
                setStep((step + 1) as Step)
              }}
            >
              下一步
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!nameOk || workspace === null || templateId === null || submitting}
              onClick={() => void submit()}
            >
              {submitting ? '正在招呼…' : '招他入伙'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
