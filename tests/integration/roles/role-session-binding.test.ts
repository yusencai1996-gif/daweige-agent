import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { createRoleFixture, type RoleFixture } from '../helpers/role-fixture'

/**
 * A3 会话关联(PLAN §10.2):会话挂角色、多会话不串、删除清 binding、归档恢复、
 * legacy-unresolved/missing 挂载拒绝新建。
 */

let dir: string
let roleFx: RoleFixture
let sessionRepo: SessionRepository
let service: SessionService

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'role-binding-'))
  roleFx = await createRoleFixture('账房')
  sessionRepo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  service = new SessionService(sessionRepo, roleFx.roleRepository, roleFx.roleService)
})

afterEach(async () => {
  await sessionRepo.close().catch(() => {})
  await roleFx.roleRepository.drainAndClose()
  await Promise.all([
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    rm(roleFx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
  ])
}, 20_000)

describe('会话与角色绑定', () => {
  it('按角色创建两会话:cwd=角色主挂载,binding 各自正确,列表带 roleId', async () => {
    const a = await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm1' })
    const b = await service.create({ roleId: roleFx.roleId, providerId: 'deepseek', modelId: 'm2' })
    // 回归锁(真机验收抓的 bug):create 返回的 summary.roleId 必须非 null,前端靠返回值归组
    expect(a.summary.roleId).toBe(roleFx.roleId)
    expect(b.summary.roleId).toBe(roleFx.roleId)
    expect(a.summary.archivedAt).toBeNull()
    expect(a.summary.workspacePath).toBe(roleFx.workspaceDir)
    expect(b.summary.workspacePath).toBe(roleFx.workspaceDir)
    expect(a.summary.id).not.toBe(b.summary.id)

    const list = await service.listSummaries()
    expect(list).toHaveLength(2)
    expect(list.every((s) => s.roleId === roleFx.roleId)).toBe(true)
    expect(list.every((s) => s.archivedAt === null)).toBe(true)
    // provider/model 各自保留(不因同角色互串)
    const byId = new Map(list.map((s) => [s.id, s]))
    expect(byId.get(a.summary.id)!.modelId).toBe('m1')
    expect(byId.get(b.summary.id)!.modelId).toBe('m2')
  })

  it('删除会话同时清 binding,不动 pi 之外的库', async () => {
    const a = await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
    await service.remove(a.summary.id)
    expect(await service.listSummaries()).toHaveLength(0)
    expect(await roleFx.roleRepository.getBinding(a.summary.id)).toBeUndefined()
    // 角色计数归零
    const role = await roleFx.roleService.getSummary(roleFx.roleId)
    expect(role.sessionCount).toBe(0)
  })

  it('会话归档/恢复:archivedAt 往返,pi 数据不动', async () => {
    const a = await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
    const archived = await service.setArchived(a.summary.id, true)
    expect(archived.archivedAt).not.toBeNull()
    const list = await service.listSummaries()
    expect(list[0]!.archivedAt).not.toBeNull()

    const restored = await service.setArchived(a.summary.id, false)
    expect(restored.archivedAt).toBeNull()
    // pi 会话仍可打开(归档不删数据)
    const detail = await service.openDetail(a.summary.id)
    expect(detail.summary.id).toBe(a.summary.id)
  })

  it('internal 会话不进用户列表(S-01/0.3.0 前置):visibility=internal 被过滤,数据仍可打开', async () => {
    const a = await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
    const b = await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
    // 把 b 模拟成子 agent 运行会话:binding 改 internal(bindSession 是 INSERT OR IGNORE,先删再插)
    await roleFx.roleRepository.deleteBinding(b.summary.id)
    await roleFx.roleRepository.bindSession({
      sessionId: b.summary.id,
      roleId: roleFx.roleId,
      workspacePathSnapshot: b.summary.workspacePath ?? '',
      archivedAt: null,
      visibility: 'internal',
      source: 'repair',
    })
    const list = await service.listSummaries()
    expect(list.map((s) => s.id)).toEqual([a.summary.id])
    // internal 会话本身数据完好(0.3.0 子 agent 会话详情入口用)
    const detail = await service.openDetail(b.summary.id)
    expect(detail.summary.id).toBe(b.summary.id)
  })

  it('legacy-unresolved 角色拒绝新建会话', async () => {
    const roleRepo = roleFx.roleRepository
    // 造一个 unresolved 角色(直接入库,模拟迁移产物)
    const now = Date.now()
    await roleRepo.insertRoleInTransaction({
      role: {
        id: 'agent-ffffffffffff',
        kind: 'legacy-unresolved',
        displayName: '未找到文件夹的旧会话-abc',
        templateId: 'legacy-empty',
        homeRelPath: 'daweige/agents/agent-ffffffffffff',
        guardrailsRelPath: 'guardrails.md',
        createdAt: now,
        updatedAt: now,
      },
      mounts: [],
    })
    await expect(
      service.create({ roleId: 'agent-ffffffffffff', providerId: 'kimi-coding', modelId: 'm' }),
    ).rejects.toThrow(/没有找到工作文件夹/)
  })

  it('挂载目录消失(missing)后拒绝新建会话', async () => {
    // 另建一个角色,挂载后删掉目录
    const detail = await roleFx.roleService.createRole({
      displayName: '临时管家',
      workspacePaths: [join(dir, 'will-vanish')],
      primaryWorkspacePath: join(dir, 'will-vanish'),
      templateId: 'file-steward',
      guardrails: '',
    })
    // 目录本就不存在(没建过)→ missing
    await expect(
      service.create({ roleId: detail.summary.id, providerId: 'kimi-coding', modelId: 'm' }),
    ).rejects.toThrow(/工作文件夹目前不存在/)
  })

  it('不存在角色/未注入角色层的明确错误', async () => {
    await expect(
      service.create({ roleId: 'agent-1234567890ab', providerId: 'kimi-coding', modelId: 'm' }),
    ).rejects.toThrow()
    const bare = new SessionService(sessionRepo)
    await expect(
      bare.create({ roleId: 'agent-1234567890ab', providerId: 'kimi-coding', modelId: 'm' }),
    ).rejects.toThrow(/角色功能/)
  })
})
