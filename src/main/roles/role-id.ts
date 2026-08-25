import { randomBytes } from 'node:crypto'

/**
 * 角色 ID(PLAN §2.2):`agent-` + 12 位小写十六进制,crypto.randomBytes 生成。
 * 显示名可改,ID/家目录/历史绑定永不随之变化;sys- 前缀保留给第二步总管,
 * 渲染进程创建入口不接受(契约 schema 只认 agent- 格式)。
 */

export const ROLE_ID_PATTERN = /^agent-[a-f0-9]{12}$/

export function isValidRoleId(value: string): boolean {
  return ROLE_ID_PATTERN.test(value)
}

export function generateRoleId(): string {
  return `agent-${randomBytes(6).toString('hex')}`
}
