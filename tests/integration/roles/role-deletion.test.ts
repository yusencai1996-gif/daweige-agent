import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { RoleService, type RoleDeleteHooks } from '../../../src/main/roles/role-service'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'

/**
 * 角色删除状态机(PLAN §10.2):影响清单+防 TOCTOU、
 * 删除顺序(pi 会话→家目录→注册行)、usage 不动由调用方保证(不注入 UsageStore 即证)、
 * 中途失败 job 可续跑。
 */

let userData: string
let roleRepo: RoleRepository
let sessionRepo: SessionRepository
let sessionService: SessionService
let service: RoleService

let interrupted: string[]
let settledApprovals: string[]
/** 可控失败点:第 N 次 removeSession 抛错(模拟 pi 删除中途失败)。 */
let failOnRemoveSession: number
let removeCount: number

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'role-del-'))
  roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  sessionRepo = new SessionRepository(join(userData, 'data', 'sessions2.sqlite'))
  await sessionRepo.init()
  service = new RoleService(userData, roleRepo, sessionRepo)
  sessionService = new SessionService(sessionRepo, roleRepo, service)
  interrupted = []
  settledApprovals = []
  failOnRemoveSession = -1
  removeCount = 0
})

afterEach(async () => {
  await sessionRepo.close().catch(() => {})
  await roleRepo.drainAndClose()
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}, 20_000)

function hooks(): RoleDeleteHooks {
  return {
    interruptSession: (id) => interrupted.push(id),
    settleApprovals: (id) => settledApprovals.push(id),
    removeSession: async (id) => {
      removeCount += 1
      if (removeCount === failOnRemoveSession) throw new Error('模拟 pi 删除失败')
      await sessionService.remove(id)
    },
  }
}

async function seedRoleWithSessions(name = '小编', sessions = 2) {
  const ws = join(userData, `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  await mkdir(ws, { recursive: true })
  const detail = await service.createRole({
    displayName: name,
    workspacePaths: [ws],
    primaryWorkspacePath: ws,
    templateId: 'writer',
    guardrails: '# 守则',
  })
  const ids: string[] = []
  for (let i = 0; i < sessions; i++) {
    const s = await sessionService.create({
      roleId: detail.summary.id,
      providerId: 'kimi-coding',
      modelId: 'm',
    })
    ids.push(s.summary.id)
  }
  return { roleId: detail.summary.id, sessionIds: ids }
}

describe('删除影响清单与防 TOCTOU', () => {
  it('影响清单:角色名/会话数/标题≤5/家目录相对路径/impactVersion', async () => {
    const { roleId } = await seedRoleWithSessions('账房', 7)
    const impact = await service.getDeleteImpact(roleId)
    expect(impact.displayName).toBe('账房')
    expect(impact.sessionCount).toBe(7)
    expect(impact.sessionTitles.length).toBeLessThanOrEqual(5)
    expect(impact.homePath).toBe(`daweige/agents/${roleId}`)
    expect(impact.impactVersion).toMatch(/^[0-9a-f]{16}$/)
  })

  it('impactVersion 随会话增删变化;输名不一致/版本过期均拒绝', async () => {
    const { roleId } = await seedRoleWithSessions('管家', 1)
    const impact = await service.getDeleteImpact(roleId)

    // 名字不匹配
    await expect(
      service.deleteRole(roleId, { confirmDisplayName: '别人的名字', impactVersion: impact.impactVersion, deleteSessions: true }, hooks()),
    ).rejects.toMatchObject({ code: 'ROLE_DELETE_CONFIRM_MISMATCH' })

    // 加一个会话 → impactVersion 过期
    await sessionService.create({ roleId, providerId: 'kimi-coding', modelId: 'm' })
    await expect(
      service.deleteRole(roleId, { confirmDisplayName: '管家', impactVersion: impact.impactVersion, deleteSessions: true }, hooks()),
    ).rejects.toMatchObject({ code: 'ROLE_DELETE_IMPACT_STALE' })
    // 此时未删除任何东西
    expect(await sessionService.listSummaries()).toHaveLength(2)
  })
})

describe('删除执行与状态机', () => {
  it('完整删除:会话清空、家目录消失、注册行与 job 清空;usage 不在本流程', async () => {
    const { roleId, sessionIds } = await seedRoleWithSessions('小编', 2)
    const impact = await service.getDeleteImpact(roleId)
    const result = await service.deleteRole(
      roleId,
      { confirmDisplayName: '小编', impactVersion: impact.impactVersion, deleteSessions: true },
      hooks(),
    )
    expect(result.deletedRoleId).toBe(roleId)
    expect([...result.deletedSessionIds].sort()).toEqual([...sessionIds].sort())
    expect(await sessionService.listSummaries()).toHaveLength(0)
    expect(existsSync(join(userData, 'daweige', 'agents', roleId))).toBe(false)
    expect(await roleRepo.getRoleRow(roleId)).toBeUndefined()
    expect(await roleRepo.listDeletionJobs()).toHaveLength(0)
    // 中断/收尾对每个会话执行过
    expect(interrupted.sort()).toEqual([...sessionIds].sort())
    expect(settledApprovals.sort()).toEqual([...sessionIds].sort())
  })

  it('中途失败:角色标记 delete_failed,job 记录剩余会话,家目录仍在;续跑 resumeDeletionJobs 完成', async () => {
    const { roleId } = await seedRoleWithSessions('小编', 2)
    const impact = await service.getDeleteImpact(roleId)
    failOnRemoveSession = 2 // 第二个会话删除失败
    await expect(
      service.deleteRole(roleId, { confirmDisplayName: '小编', impactVersion: impact.impactVersion, deleteSessions: true }, hooks()),
    ).rejects.toMatchObject({ code: 'ROLE_DELETE_FAILED' })

    // 状态:delete_failed + job 存在 + 家目录保留(守则档案不丢)
    expect((await roleRepo.getRoleRow(roleId))!.lifecycle).toBe('delete_failed')
    const job = await roleRepo.getDeletionJob(roleId)
    expect(job).toBeDefined()
    expect(existsSync(join(userData, 'daweige', 'agents', roleId, 'guardrails.md'))).toBe(true)

    // 续跑(重启场景):跳过确认,从剩余会话继续到完成
    failOnRemoveSession = -1
    const results = await service.resumeDeletionJobs(hooks())
    expect(results).toHaveLength(1)
    expect(await roleRepo.getRoleRow(roleId)).toBeUndefined()
    expect(await roleRepo.listDeletionJobs()).toHaveLength(0)
    expect(await sessionService.listSummaries()).toHaveLength(0)
    expect(existsSync(join(userData, 'daweige', 'agents', roleId))).toBe(false)
  })

  it('幂等死角修复(初审阻断项):家目录已删+注册行残留 → 续跑能收尾不卡死', async () => {
    const { roleId } = await seedRoleWithSessions('小编', 1)
    const impact = await service.getDeleteImpact(roleId)
    // 手工制造中间态:走正常删除到一半,直接删掉家目录+保留注册行(job 在)
    await service.deleteRole(roleId, { confirmDisplayName: '小编', impactVersion: impact.impactVersion, deleteSessions: true }, hooks())
    // 上面是完整删除;改为构造半删除:重新建角色,手动把库置成 deleting+job,且家目录已不存在
    const { roleId: roleId2 } = await seedRoleWithSessions('半删管家', 1)
    const home = join(userData, 'daweige', 'agents', roleId2)
    await rm(home, { recursive: true, force: true }) // 家目录被外部删掉
    await roleRepo.setRoleLifecycle(roleId2, 'deleting', Date.now())
    await roleRepo.upsertDeletionJob({ roleId: roleId2, impactVersion: 'confirmed', pendingSessionIds: [], phase: 'delete-sessions' })
    // 续跑:家目录不存在不抛 ENOENT,能走完"事务清行"收尾
    const results = await service.resumeDeletionJobs(hooks())
    expect(results).toHaveLength(1)
    expect(await roleRepo.getRoleRow(roleId2)).toBeUndefined()
    expect(await roleRepo.listDeletionJobs()).toHaveLength(0)
  })

  it('伪造 roleId 删除被拒(路径校验前置)', async () => {
    await expect(
      service.deleteRole('../evil', { confirmDisplayName: 'x', impactVersion: 'v', deleteSessions: true }, hooks()),
    ).rejects.toMatchObject({ code: 'ROLE_ID_INVALID' })
  })
})
