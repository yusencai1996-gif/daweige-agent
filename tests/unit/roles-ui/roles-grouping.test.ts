import { describe, expect, it } from 'vitest'
import type { RoleSummary, SessionSummary } from '../../../src/shared/domain'
import {
  countArchived,
  groupForArchive,
  groupForSidebar,
} from '../../../src/renderer/features/roles/roles-grouping'

function role(partial: Partial<RoleSummary> & { readonly id: string }): RoleSummary {
  return {
    kind: 'worker',
    displayName: partial.id,
    templateId: 'writer',
    mounts: [],
    archivedAt: null,
    lifecycle: 'ready',
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    ...partial,
  }
}

function session(partial: Partial<SessionSummary> & { readonly id: string }): SessionSummary {
  return {
    title: partial.id,
    workspacePath: 'C:\\w',
    roleId: null,
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...partial,
  }
}

describe('roles-grouping(侧栏/归档区分组过滤)', () => {
  it('侧栏:归档角色与归档会话不进主列表,会话按 updatedAt 倒序挂到角色下', () => {
    const roles = [
      role({ id: 'r1', createdAt: 2 }),
      role({ id: 'r2', createdAt: 1 }),
      role({ id: 'r3', createdAt: 0, archivedAt: 5 }),
    ]
    const sessions = [
      session({ id: 's1', roleId: 'r1', updatedAt: 10 }),
      session({ id: 's2', roleId: 'r1', updatedAt: 20 }),
      session({ id: 's3', roleId: 'r1', archivedAt: 30 }),
      session({ id: 's4', roleId: 'r3', updatedAt: 40 }),
    ]
    const groups = groupForSidebar(roles, sessions)
    expect(groups.roleGroups.map((g) => g.role.id)).toEqual(['r2', 'r1'])
    expect(groups.roleGroups[1]?.sessions.map((s) => s.id)).toEqual(['s2', 's1'])
    expect(groups.ungroupedSessions).toEqual([])
  })

  it('侧栏:roleId 为 null 或角色缺失的会话进「未分组」防御分组', () => {
    const sessions = [
      session({ id: 's1', roleId: null, updatedAt: 1 }),
      session({ id: 's2', roleId: 'ghost', updatedAt: 2 }),
      session({ id: 's3', roleId: null, archivedAt: 3 }),
    ]
    const groups = groupForSidebar([], sessions)
    expect(groups.ungroupedSessions.map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('归档区:角色归档的子会话不在会话页签重复出现;恢复角色后独立归档会话仍在', () => {
    const roles = [role({ id: 'r1' }), role({ id: 'r2', archivedAt: 100 })]
    const sessions = [
      session({ id: 's1', roleId: 'r1', archivedAt: 10 }),
      session({ id: 's2', roleId: 'r2', archivedAt: 20 }),
      session({ id: 's3', roleId: 'r2' }),
      session({ id: 's4', roleId: null, archivedAt: 30 }),
    ]
    const archive = groupForArchive(roles, sessions)
    expect(archive.archivedRoles.map((r) => r.id)).toEqual(['r2'])
    const r1Group = archive.sessionGroups.find((g) => g.role?.id === 'r1')
    expect(r1Group?.sessions.map((s) => s.id)).toEqual(['s1'])
    const orphanGroup = archive.sessionGroups.find((g) => g.role === null)
    expect(orphanGroup?.sessions.map((s) => s.id)).toEqual(['s4'])
    expect(archive.sessionGroups.some((g) => g.role?.id === 'r2')).toBe(false)
  })

  it('归档计数:归档角色数 + 独立归档会话数(角色归档的会话不重复计)', () => {
    const roles = [role({ id: 'r1', archivedAt: 1 }), role({ id: 'r2' })]
    const sessions = [
      session({ id: 's1', roleId: 'r1', archivedAt: 2 }),
      session({ id: 's2', roleId: 'r2', archivedAt: 3 }),
      session({ id: 's3', roleId: 'r2' }),
    ]
    expect(countArchived(roles, sessions)).toBe(2)
    expect(countArchived([], [])).toBe(0)
  })

  it('B-04:deleting/delete_failed 角色不进主列表,其会话也不掉进未分组', () => {
    const roles = [
      role({ id: 'r1' }),
      role({ id: 'r2', lifecycle: 'delete_failed' }),
      role({ id: 'r3', lifecycle: 'deleting' }),
    ]
    const sessions = [
      session({ id: 's1', roleId: 'r1', updatedAt: 1 }),
      session({ id: 's2', roleId: 'r2', updatedAt: 2 }),
      session({ id: 's3', roleId: 'r3', updatedAt: 3 }),
    ]
    const groups = groupForSidebar(roles, sessions)
    expect(groups.roleGroups.map((g) => g.role.id)).toEqual(['r1'])
    expect(groups.ungroupedSessions).toEqual([])
  })

  it('B-04:deleting/delete_failed 角色进归档区角色页签(未归档的排在已归档后面)', () => {
    const roles = [
      role({ id: 'r1' }),
      role({ id: 'r2', lifecycle: 'delete_failed' }),
      role({ id: 'r3', lifecycle: 'deleting' }),
      role({ id: 'r4', archivedAt: 100 }),
    ]
    const archive = groupForArchive(roles, [])
    expect(archive.archivedRoles.map((r) => r.id)).toEqual(['r4', 'r2', 'r3'])
  })

  it('B-04:归档计数把 deleting/delete_failed 角色计入', () => {
    const roles = [
      role({ id: 'r1', archivedAt: 1 }),
      role({ id: 'r2', lifecycle: 'delete_failed' }),
      role({ id: 'r3', lifecycle: 'deleting' }),
      role({ id: 'r4' }),
    ]
    expect(countArchived(roles, [])).toBe(3)
  })
})
