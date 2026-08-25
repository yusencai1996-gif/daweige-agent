// A-13:聊天气泡/欢迎页的 AI 名字跟会话所属角色走;无会话/无角色兜底「小柊」。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASSISTANT_NAME,
  resolveActiveRoleName,
} from '../../../src/renderer/app/active-role-name'
import type { RoleSummary, SessionDetail } from '../../../src/shared/domain'

const roles: RoleSummary[] = [
  {
    id: 'agent-a1b2c3d4e5f6',
    kind: 'worker',
    displayName: '小编',
    templateId: 'writer',
    mounts: [],
    archivedAt: null,
    lifecycle: 'ready',
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    activeSessionCount: 1,
  },
]

function detailOf(roleId: string | null): SessionDetail {
  return {
    summary: {
      id: 'session-1',
      title: '测试会话',
      workspacePath: 'C:\\demo',
      roleId,
      archivedAt: null,
      providerId: 'kimi-coding',
      modelId: 'kimi-for-coding',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    },
    messages: [],
  }
}

describe('resolveActiveRoleName(A-13)', () => {
  it('会话有角色 → 角色 displayName', () => {
    expect(resolveActiveRoleName(roles, detailOf('agent-a1b2c3d4e5f6'))).toBe('小编')
  })

  it('无会话 → 兜底小柊', () => {
    expect(resolveActiveRoleName(roles, null)).toBe(DEFAULT_ASSISTANT_NAME)
    expect(DEFAULT_ASSISTANT_NAME).toBe('小柊')
  })

  it('会话无角色(roleId=null)→ 兜底小柊', () => {
    expect(resolveActiveRoleName(roles, detailOf(null))).toBe('小柊')
  })

  it('角色列表里找不到(已删除等)→ 兜底小柊', () => {
    expect(resolveActiveRoleName(roles, detailOf('agent-gone'))).toBe('小柊')
  })
})
