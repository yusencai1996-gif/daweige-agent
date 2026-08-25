import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RoleRepository,
  type InsertRoleInput,
} from '../../../src/main/roles/role-repository'

/**
 * 角色库单测:schema 落地、CRUD、挂载唯一、绑定聚合、删除 job。
 * 集成链(staging/家目录/补偿)见 tests/integration/roles/。
 */

let dir: string
let repo: RoleRepository

function roleInput(id: string, name = '小编'): InsertRoleInput {
  const now = Date.now()
  return {
    role: {
      id,
      kind: 'worker',
      displayName: name,
      templateId: 'writer',
      homeRelPath: `daweige/agents/${id}`,
      guardrailsRelPath: 'guardrails.md',
      createdAt: now,
      updatedAt: now,
    },
    mounts: [
      {
        workspacePath: 'C:\\Users\\demo\\Documents\\稿件',
        canonicalKey: 'c:/users/demo/documents/稿件',
        ordinal: 0,
        isPrimary: true,
        availability: 'available',
      },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roles-repo-'))
  repo = new RoleRepository(join(dir, 'roles.sqlite'))
})

afterEach(async () => {
  await repo.drainAndClose()
  rmSync(dir, { recursive: true, force: true })
})

describe('RoleRepository:roles 表', () => {
  it('插入并按创建序读回;默认 lifecycle=ready/guardrails_version=1', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    const rows = await repo.listRoleRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'agent-a1b2c3d4e5f6',
      displayName: '小编',
      kind: 'worker',
      lifecycle: 'ready',
      guardrailsVersion: 1,
      archivedAt: null,
    })
  })

  it('改名/归档/恢复/lifecycle 更新落库', async () => {
    const id = 'agent-a1b2c3d4e5f6'
    await repo.insertRole(roleInput(id))
    await repo.updateDisplayName(id, '大编', 2)
    await repo.setRoleArchived(id, 123, 3)
    await repo.setRoleLifecycle(id, 'deleting', 4)
    const row = await repo.getRoleRow(id)
    expect(row).toMatchObject({ displayName: '大编', archivedAt: 123, lifecycle: 'deleting' })
    await repo.setRoleArchived(id, null, 5)
    expect((await repo.getRoleRow(id))!.archivedAt).toBeNull()
  })

  it('guardrails_version 递增独立于 updated_at', async () => {
    const id = 'agent-a1b2c3d4e5f6'
    await repo.insertRole(roleInput(id))
    await repo.updateGuardrailsVersion(id, 2, 1)
    await repo.updateGuardrailsVersion(id, 3, 2)
    expect((await repo.getRoleRow(id))!.guardrailsVersion).toBe(3)
  })

  it('非法 kind/lifecycle 被 CHECK 拒(防脏数据)', async () => {
    const input = roleInput('agent-a1b2c3d4e5f6')
    ;(input.role as { kind: string }).kind = 'hacker'
    await expect(repo.insertRole(input)).rejects.toThrow()
  })
})

describe('RoleRepository:挂载唯一', () => {
  it('同一 canonical_key 不能挂两个角色(UNIQUE 拒绝)', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    await expect(repo.insertRole(roleInput('agent-b2c3d4e5f6a7'))).rejects.toThrow(/UNIQUE/i)
  })

  it('相同 key(已由 service 归一化)拒绝;不同目录放行', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    const other = roleInput('agent-b2c3d4e5f6a7')
    // service 层 normalizeKey 保证写入前已小写;DB 层只做精确 UNIQUE
    const otherMounts = [{ ...other.mounts[0]!, canonicalKey: 'c:/users/demo/documents/稿件' }]
    await expect(repo.insertRole({ ...other, mounts: otherMounts })).rejects.toThrow(/UNIQUE/i)

    const third = roleInput('agent-c3d4e5f6a7b8')
    const thirdMounts = [{ ...third.mounts[0]!, canonicalKey: 'd:/门店报表' }]
    await expect(repo.insertRole({ ...third, mounts: thirdMounts })).resolves.toBeUndefined()
  })

  it('findRoleIdByCanonicalKey 命中/未命中', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    expect(await repo.findRoleIdByCanonicalKey('c:/users/demo/documents/稿件')).toBe('agent-a1b2c3d4e5f6')
    expect(await repo.findRoleIdByCanonicalKey('d:/other')).toBeUndefined()
  })
})

describe('RoleRepository:绑定', () => {
  it('bindSession/getBinding/listBindingRows 往返', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    await repo.bindSession({
      sessionId: 'sess-1',
      roleId: 'agent-a1b2c3d4e5f6',
      workspacePathSnapshot: 'C:\\Users\\demo\\Documents\\稿件',
      archivedAt: null,
      visibility: 'user',
      source: 'created',
      boundAt: 100,
    })
    const binding = await repo.getBinding('sess-1')
    expect(binding).toMatchObject({ roleId: 'agent-a1b2c3d4e5f6', source: 'created', visibility: 'user' })

    await repo.setSessionArchived('sess-1', 999)
    expect((await repo.getBinding('sess-1'))!.archivedAt).toBe(999)

    await repo.deleteBinding('sess-1')
    expect(await repo.getBinding('sess-1')).toBeUndefined()
  })

  it('重复 bindSession 幂等(INSERT OR IGNORE 不报错)', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    const input = {
      sessionId: 'sess-1',
      roleId: 'agent-a1b2c3d4e5f6',
      workspacePathSnapshot: 'C:\\demo',
      archivedAt: null,
      visibility: 'user' as const,
      source: 'created' as const,
    }
    await repo.bindSession(input)
    await expect(repo.bindSession(input)).resolves.toBeUndefined()
    expect(await repo.listBindingRows()).toHaveLength(1)
  })

  it('绑定到不存在角色被外键拒绝', async () => {
    await expect(
      repo.bindSession({
        sessionId: 'sess-x',
        roleId: 'agent-zzzzzzzzzzzz',
        workspacePathSnapshot: 'C:\\demo',
        archivedAt: null,
        visibility: 'user',
        source: 'created',
      }),
    ).rejects.toThrow()
  })

  it('listSessionCounts:user 会话聚合计数,internal 不计入', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    await repo.bindSession({ sessionId: 's1', roleId: 'agent-a1b2c3d4e5f6', workspacePathSnapshot: 'C:\\d', archivedAt: null, visibility: 'user', source: 'created' })
    await repo.bindSession({ sessionId: 's2', roleId: 'agent-a1b2c3d4e5f6', workspacePathSnapshot: 'C:\\d', archivedAt: 5, visibility: 'user', source: 'created' })
    await repo.bindSession({ sessionId: 's3', roleId: 'agent-a1b2c3d4e5f6', workspacePathSnapshot: 'C:\\d', archivedAt: null, visibility: 'internal', source: 'created' })
    const counts = await repo.listSessionCounts()
    expect(counts.get('agent-a1b2c3d4e5f6')).toEqual({ sessionCount: 2, activeSessionCount: 1 })
  })
})

describe('RoleRepository:删除 job 与 meta', () => {
  it('upsert 幂等覆盖;pendingSessionIds JSON 往返', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    await repo.upsertDeletionJob({
      roleId: 'agent-a1b2c3d4e5f6',
      impactVersion: 'v1',
      pendingSessionIds: ['s1', 's2'],
      phase: 'delete-sessions',
    })
    await repo.upsertDeletionJob({
      roleId: 'agent-a1b2c3d4e5f6',
      impactVersion: 'v1',
      pendingSessionIds: ['s2'],
      phase: 'delete-home',
      lastError: 'boom',
    })
    const job = await repo.getDeletionJob('agent-a1b2c3d4e5f6')
    expect(job).toMatchObject({ phase: 'delete-home', pendingSessionIds: ['s2'], lastError: 'boom' })

    await repo.deleteDeletionJob('agent-a1b2c3d4e5f6')
    expect(await repo.getDeletionJob('agent-a1b2c3d4e5f6')).toBeUndefined()
  })

  it('meta 读写与覆盖', async () => {
    expect(await repo.getMeta('role_migration_v1')).toBeUndefined()
    await repo.setMeta('role_migration_v1', 'completed')
    expect(await repo.getMeta('role_migration_v1')).toBe('completed')
    await repo.setMeta('role_migration_v1', 'completed-v2')
    expect(await repo.getMeta('role_migration_v1')).toBe('completed-v2')
  })

  it('删除角色行级联清掉挂载/绑定/job(ON DELETE CASCADE)', async () => {
    await repo.insertRole(roleInput('agent-a1b2c3d4e5f6'))
    await repo.bindSession({ sessionId: 's1', roleId: 'agent-a1b2c3d4e5f6', workspacePathSnapshot: 'C:\\d', archivedAt: null, visibility: 'user', source: 'created' })
    await repo.upsertDeletionJob({ roleId: 'agent-a1b2c3d4e5f6', impactVersion: 'v1', pendingSessionIds: [], phase: 'start' })
    await repo.deleteRoleRow('agent-a1b2c3d4e5f6')
    expect(await repo.listMountRows()).toHaveLength(0)
    expect(await repo.listBindingRows()).toHaveLength(0)
    expect(await repo.listDeletionJobs()).toHaveLength(0)
  })
})
