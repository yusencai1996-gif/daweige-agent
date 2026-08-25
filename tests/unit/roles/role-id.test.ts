import { describe, expect, it } from 'vitest'
import { generateRoleId, isValidRoleId } from '../../../src/main/roles/role-id'

describe('roleId(PLAN §2.2)', () => {
  it('生成格式恒为 agent-+12 位小写 hex', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRoleId()
      expect(isValidRoleId(id), `生成的 ${id} 应合法`).toBe(true)
    }
  })

  it('拒绝:大写/短/长/前缀错误/路径逃逸/空', () => {
    for (const bad of [
      'agent-ABCDEF123456',
      'agent-a1b2c3',
      'agent-a1b2c3d4e5f66',
      'sys-xiaozhen',
      '../evil',
      'agent-../evil123',
      '',
      'agent-g1h2i3j4k5l6',
    ]) {
      expect(isValidRoleId(bad), `"${bad}" 应被拒绝`).toBe(false)
    }
  })

  it('两次生成不重复(碰撞概率级验证,非绝对保证)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateRoleId())
    expect(seen.size).toBe(1000)
  })
})
