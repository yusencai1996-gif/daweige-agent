import type {
  ProviderInfo,
  ProviderSelection,
  RoleSummary,
  Settings,
} from '../../../shared/domain'
import { sameModel } from '../../../shared/domain/model-selection'

interface RoleDefaultModelPanelProps {
  /** 全部角色(面板内部过滤掉已归档;小柊内置总管也在列表里)。 */
  readonly roles: readonly RoleSummary[]
  /** 启用池(settings.enabledModels):逐项下拉的选项来源;空池时引导先勾选。 */
  readonly enabledModels: readonly ProviderSelection[]
  /** 现有角色默认映射(settings.roleModelDefaults)。 */
  readonly roleModelDefaults: Settings['roleModelDefaults']
  readonly providers: readonly ProviderInfo[]
  /** 设置/清除某角色默认(selection=null 即「跟随全局」);写入由 controller 走 settings 串行链。 */
  readonly onSetRoleDefault: (roleId: string, selection: ProviderSelection | null) => void
}

function keyOf(selection: ProviderSelection): string {
  return `${selection.providerId}::${selection.modelId}`
}

/**
 * 角色默认模型面板(A-24,PLAN §2.2):列出未归档角色与小柊,
 * 每项从启用池选默认模型,另有「跟随全局」;缺省/映射失效都按跟随全局显示。
 */
export function RoleDefaultModelPanel({
  roles,
  enabledModels,
  roleModelDefaults,
  providers,
  onSetRoleDefault,
}: RoleDefaultModelPanelProps) {
  const activeRoles = roles.filter((role) => role.archivedAt === null)
  const providerName = (providerId: string): string =>
    providers.find((p) => p.id === providerId)?.displayName ?? providerId

  return (
    <div className="cred-panel role-model-panel">
      <div className="cred-panel-title">角色默认模型</div>
      <div className="cred-panel-desc">
        给某个角色单独指定常用模型;不指定就跟着全局默认走。会话里临时换模型不改这里。
      </div>
      {enabledModels.length === 0 ? (
        <div className="role-model-empty">
          先在上方模型清单里勾选常用模型,才能给角色单独指定。
        </div>
      ) : (
        <ul className="role-model-list">
          {activeRoles.map((role) => {
            const current = roleModelDefaults?.[role.id]
            // 映射引用的模型已不在池:按「跟随全局」显示(主进程会在下次写入时剪枝)
            const valid = current !== undefined && enabledModels.some((m) => sameModel(m, current))
            return (
              <li key={role.id} className="role-model-row">
                <span className="role-model-name" title={role.displayName}>
                  {role.displayName}
                </span>
                <select
                  className="role-model-select"
                  aria-label={`${role.displayName}的默认模型`}
                  value={valid && current !== undefined ? keyOf(current) : ''}
                  onChange={(e) => {
                    const key = e.target.value
                    const found = enabledModels.find((m) => keyOf(m) === key)
                    onSetRoleDefault(role.id, found ?? null)
                  }}
                >
                  <option value="">跟随全局</option>
                  {enabledModels.map((m) => (
                    <option key={keyOf(m)} value={keyOf(m)}>
                      {m.modelId} · {providerName(m.providerId)}
                    </option>
                  ))}
                </select>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
