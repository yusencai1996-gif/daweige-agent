import { useEffect, useRef, useState } from 'react'
import type { RoleDeleteImpact, RoleSummary } from '../../../shared/domain'
import type { DeleteRoleResult } from '../../app/use-app-controller'

/**
 * 角色彻底删除确认(overlay):
 * 1. 打开时拉 role:getDeleteImpact 影响清单;
 * 2. 输入完整角色名(type-to-confirm)才放行;
 * 3. impactVersion 失效 → 提示并重拉回到清单;
 * 4. 其他失败 → 「删除没有完成,可以重试」。
 */

interface RoleDeleteDialogProps {
  readonly role: RoleSummary
  readonly getDeleteImpact: (roleId: string) => Promise<RoleDeleteImpact>
  readonly onDelete: (
    roleId: string,
    confirmDisplayName: string,
    impactVersion: string,
  ) => Promise<DeleteRoleResult>
  readonly onCancel: () => void
}

export function RoleDeleteDialog({
  role,
  getDeleteImpact,
  onDelete,
  onCancel,
}: RoleDeleteDialogProps) {
  const [impact, setImpact] = useState<RoleDeleteImpact | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const loadImpact = async (tip: string | null) => {
    setLoadError(null)
    setNotice(tip)
    try {
      const data = await getDeleteImpact(role.id)
      setImpact(data)
      setConfirmName('')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  // 打开时加载影响清单
  useEffect(() => {
    let alive = true
    setLoadError(null)
    getDeleteImpact(role.id)
      .then((data) => {
        if (alive) setImpact(data)
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [getDeleteImpact, role.id])

  const nameMatches = impact !== null && confirmName === impact.displayName

  const confirmDelete = async () => {
    if (impact === null || !nameMatches || deleting) return
    setDeleting(true)
    const result = await onDelete(role.id, confirmName, impact.impactVersion)
    setDeleting(false)
    if (result.ok) return // 弹层由 controller 关闭
    if (result.stale) {
      // impactVersion 失效:数据变了,重拉影响清单回到确认前
      await loadImpact('角色信息有变化,已刷新影响清单;请重新确认。')
    } else {
      setNotice(`删除没有完成,可以重试。(${result.message})`)
    }
  }

  return (
    <div className="role-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="role-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`彻底删除角色「${role.displayName}」`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !deleting) onCancel()
        }}
      >
        <div className="role-dialog-head">
          <div className="role-dialog-title">彻底删除「{role.displayName}」?</div>
        </div>

        <div className="role-dialog-body">
          {loadError !== null && (
            <div className="wizard-error" role="alert">
              {loadError}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void loadImpact(null)}
              >
                重试
              </button>
            </div>
          )}
          {loadError === null && impact === null && (
            <div className="muted">正在清点这个角色名下的东西…</div>
          )}
          {impact !== null && (
            <>
              <ul className="delete-impact">
                <li>
                  角色名下 {impact.sessionCount} 个会话
                  {impact.sessionTitles.length > 0 && (
                    <span className="muted">
                      :{impact.sessionTitles.join('、')}
                      {impact.sessionCount > impact.sessionTitles.length ? ' 等' : ''}
                    </span>
                  )}
                </li>
                <li>
                  角色档案目录:<span className="muted">{impact.homePath}</span>
                </li>
                <li>会话正文和角色守则会永久删除;使用统计保留。</li>
              </ul>
              <label className="wizard-label" htmlFor="delete-confirm-name">
                输入完整角色名「{impact.displayName}」确认
              </label>
              <input
                id="delete-confirm-name"
                className="text-input"
                value={confirmName}
                autoFocus
                disabled={deleting}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </>
          )}
          {notice !== null && (
            <div className="wizard-error" role="alert">
              {notice}
            </div>
          )}
        </div>

        <div className="role-dialog-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={deleting}
            onClick={onCancel}
          >
            先不删
          </button>
          <span className="role-dialog-foot-gap" />
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={!nameMatches || deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? '正在删除…' : '彻底删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
