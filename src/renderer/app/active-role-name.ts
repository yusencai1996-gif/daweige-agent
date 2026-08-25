import type { RoleSummary, SessionDetail } from '../../shared/domain'

/**
 * AI 名字的兜底(A-13):无会话 / 会话无角色(roleId=null)/ 角色已找不到时,
 * 聊天气泡与欢迎页都回到产品本名「小柊」。
 */
export const DEFAULT_ASSISTANT_NAME = '小柊'

/**
 * 当前会话里 AI 该叫啥:按会话归属的角色取 displayName。
 * 0.2.0 消息不跨角色,会话级取名即可;消息流无需逐条判断。
 */
export function resolveActiveRoleName(
  roles: readonly RoleSummary[],
  detail: SessionDetail | null,
): string {
  const roleId = detail?.summary.roleId ?? null
  if (roleId === null) return DEFAULT_ASSISTANT_NAME
  return roles.find((r) => r.id === roleId)?.displayName ?? DEFAULT_ASSISTANT_NAME
}
