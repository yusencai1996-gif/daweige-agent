import type { ProviderSelection } from './provider'
import type { RoleModelOwnerId, Settings } from './settings'

const ROLE_MODEL_OWNER_PATTERN = /^(?:agent-[a-f0-9]{12}|sys-xiaozhen)$/

export type ResolvedModelSelection = {
  readonly selection: ProviderSelection
  readonly source: 'role' | 'global' | 'fallback'
}

export function sameModel(a: ProviderSelection, b: ProviderSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/** 显式启用池为空是老数据兼容态，此时只允许全局默认。 */
export function isEnabledModel(settings: Settings, selection: ProviderSelection): boolean {
  const pool = settings.enabledModels
  if (!pool || pool.length === 0) return sameModel(settings.providerSelection, selection)
  return pool.some((item) => sameModel(item, selection))
}

export function resolveRoleModel(settings: Settings, roleId: RoleModelOwnerId): ResolvedModelSelection {
  const roleSelection = settings.roleModelDefaults?.[roleId]
  if (roleSelection && isExplicitlyEnabledModel(settings, roleSelection)) {
    return { selection: roleSelection, source: 'role' }
  }
  if (isEnabledModel(settings, settings.providerSelection)) {
    return { selection: settings.providerSelection, source: 'global' }
  }
  const fallback = settings.enabledModels?.[0]
  return fallback
    ? { selection: fallback, source: 'fallback' }
    : { selection: settings.providerSelection, source: 'global' }
}

export function withRoleModelDefault(
  settings: Settings,
  roleId: RoleModelOwnerId,
  selection: ProviderSelection | null,
): Settings {
  if (!ROLE_MODEL_OWNER_PATTERN.test(roleId)) return settings
  const next = { ...(settings.roleModelDefaults ?? {}) }
  if (selection === null || !isExplicitlyEnabledModel(settings, selection)) delete next[roleId]
  else next[roleId] = selection
  return Object.keys(next).length > 0
    ? { ...settings, roleModelDefaults: next }
    : withoutRoleModelDefaults(settings)
}

/** 清除非法 roleId 与已移出启用池的映射。孤儿角色由主进程 repository 可用时再剪。 */
export function pruneRoleModelDefaults(settings: Settings): Settings {
  const current = settings.roleModelDefaults
  if (!current) return settings
  const next: Record<string, ProviderSelection> = {}
  for (const [roleId, selection] of Object.entries(current)) {
    if (ROLE_MODEL_OWNER_PATTERN.test(roleId) && isExplicitlyEnabledModel(settings, selection)) {
      next[roleId] = selection
    }
  }
  const entries = Object.entries(next)
  if (entries.length === Object.keys(current).length && entries.every(([id, value]) => sameModel(value, current[id]!))) {
    return settings
  }
  return entries.length > 0 ? { ...settings, roleModelDefaults: next } : withoutRoleModelDefaults(settings)
}

function withoutRoleModelDefaults(settings: Settings): Settings {
  const { roleModelDefaults: _removed, ...rest } = settings
  return rest
}

function isExplicitlyEnabledModel(settings: Settings, selection: ProviderSelection): boolean {
  return settings.enabledModels?.some((item) => sameModel(item, selection)) ?? false
}
