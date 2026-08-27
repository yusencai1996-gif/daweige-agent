import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { RoleMigration } from '../../../src/main/roles/role-migration'
import { stageRoleHome } from '../../../src/main/roles/role-files'
import { buildProfile, LEGACY_EMPTY_GUARDRAILS } from '../../../src/main/roles/role-templates'

/**
 * 老会话迁移专项(PLAN §10.3):真实 pi sessions.sqlite fixture + 真实临时角色库。
 * 验证:归组规则(同 cwd/大小写/中文/同名消歧/缺失/非法)、幂等续跑、孤儿只记不删。
 */

let dir: string
let sessionRepo: SessionRepository
let roleRepo: RoleRepository
let migration: RoleMigration

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roles-mig-'))
  sessionRepo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  roleRepo = new RoleRepository(join(dir, 'data', 'roles.sqlite'))
  migration = new RoleMigration(dir, roleRepo, sessionRepo)
})

afterEach(async () => {
  await sessionRepo.close().catch(() => {})
  await roleRepo.drainAndClose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
})

async function seedSession(cwd: string): Promise<string> {
  const session = await sessionRepo.create({ cwd, providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  const meta = await session.getMetadata()
  return meta.id
}

describe('迁移:归组规则', () => {
  it('同 cwd 多会话 → 一个角色;角色名=文件夹名;binding source=migration', async () => {
    const ws = await mkdtemp(join(tmpdir(), '稿件-'))
    await seedSession(ws)
    await seedSession(ws)
    const before = await sessionRepo.list() // 迁移前 pi 元数据快照(只读红线)
    const result = await migration.run()
    expect(result.createdRoles).toBe(1)
    expect(result.migratedSessions).toBe(2)
    const after = await sessionRepo.list()
    expect(after).toEqual(before) // pi 会话库一行未动
    const roles = await roleRepo.listRoleRows()
    expect(roles).toHaveLength(1)
    expect(roles[0]!.displayName).toBe(ws.split(/[\\/]/).pop())
    expect(roles[0]!.templateId).toBe('legacy-empty')
    const bindings = await roleRepo.listBindingRows()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((b) => b.source === 'migration' && b.roleId === roles[0]!.id)).toBe(true)
    // 家目录 + 空守则
    const home = join(dir, 'daweige', 'agents', roles[0]!.id)
    expect(existsSync(join(home, 'guardrails.md'))).toBe(true)
    await rm(ws, { recursive: true, force: true })
  })

  it('同一目录大小写两种写法 → 一个角色(realpath 归一)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'case-'))
    // Windows 大小写不敏感:同一目录的另一种大小写写法
    const variant = ws.toUpperCase() === ws ? ws.toLowerCase() : ws.toUpperCase()
    await seedSession(ws)
    await seedSession(variant)
    const result = await migration.run()
    expect(result.createdRoles).toBe(1)
    expect(result.migratedSessions).toBe(2)
    await rm(ws, { recursive: true, force: true })
  })

  it('中文路径 → 正常角色', async () => {
    const ws = await mkdtemp(join(tmpdir(), '门店报表中文-'))
    await seedSession(ws)
    const result = await migration.run()
    expect(result.createdRoles).toBe(1)
    const roles = await roleRepo.listRoleRows()
    expect(roles[0]!.displayName).toContain('门店报表中文')
    await rm(ws, { recursive: true, force: true })
  })

  it('相同 basename 不同目录 → 两个角色,名称（2）消歧', async () => {
    // 两个不同父目录下各建一个同名目录(真实同名,不带随机后缀)
    const parentA = await mkdtemp(join(tmpdir(), 'disambig-a-'))
    const parentB = await mkdtemp(join(tmpdir(), 'disambig-b-'))
    const a = join(parentA, '稿件')
    const b = join(parentB, '稿件')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await seedSession(a)
    await seedSession(b)
    await migration.run()
    const roles = await roleRepo.listRoleRows()
    expect(roles).toHaveLength(2)
    const names = roles.map((r) => r.displayName).sort()
    expect(names).toEqual(['稿件', '稿件（2）'])
    await Promise.all([rm(parentA, { recursive: true, force: true }), rm(parentB, { recursive: true, force: true })])
  })

  it('cwd 不存在 → mount missing,历史会话保留', async () => {
    await seedSession(join(dir, '已经删掉的文件夹'))
    const result = await migration.run()
    expect(result.createdRoles).toBe(1)
    const mounts = await roleRepo.listMountRows()
    expect(mounts[0]!.availability).toBe('missing')
    const bindings = await roleRepo.listBindingRows()
    expect(bindings).toHaveLength(1)
  })

  it('cwd 为空 → legacy-unresolved 角色,每会话一个,禁止新建会话的 kind', async () => {
    await seedSession('')
    await seedSession('')
    const result = await migration.run()
    expect(result.createdRoles).toBe(2)
    const roles = await roleRepo.listRoleRows()
    expect(roles.every((r) => r.kind === 'legacy-unresolved')).toBe(true)
    expect(roles.every((r) => r.displayName.startsWith('未找到文件夹的旧会话-'))).toBe(true)
    // 无挂载
    const mounts = await roleRepo.listMountRows()
    expect(mounts).toHaveLength(0)
  })
})

describe('迁移:与既有角色共存', () => {
  it('旧会话 cwd 与用户先建角色的挂载同目录 → 归入既有角色,不新建角色', async () => {
    const { RoleService } = await import('../../../src/main/roles/role-service')
    const roleService = new RoleService(dir, roleRepo)
    const ws = await mkdtemp(join(tmpdir(), '既有角色-'))
    const detail = await roleService.createRole({
      displayName: '用户先建的小编',
      workspacePaths: [ws],
      primaryWorkspacePath: ws,
      templateId: 'writer',
      guardrails: '',
    })
    await seedSession(ws)
    await seedSession(ws)
    const result = await migration.run()
    // 不新建角色;两会话都归到既有角色
    expect(result.createdRoles).toBe(0)
    expect(result.migratedSessions).toBe(2)
    const roles = await roleRepo.listRoleRows()
    expect(roles).toHaveLength(1)
    expect(roles[0]!.id).toBe(detail.summary.id)
    const bindings = await roleRepo.listBindingRows()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((b) => b.roleId === detail.summary.id && b.source === 'migration')).toBe(true)
    await rm(ws, { recursive: true, force: true })
  })
})

describe('复审阻断项整改', () => {
  it('B-02 半角色抢救:DB 有行但家目录缺失 → 从 staging 恢复 promote', async () => {
    const ws = await mkdtemp(join(tmpdir(), '半角色-'))
    await seedSession(ws)
    await migration.run()
    const roles = await roleRepo.listRoleRows()
    expect(roles).toHaveLength(1)
    // 手工制造半角色:删家目录+在 staging 放一份带同 roleId 的完整家目录
    const home = join(dir, 'daweige', 'agents', roles[0]!.id)
    const stagingDir = await stageRoleHome(
      dir,
      buildProfile(roles[0]!.id, 'legacy-empty'),
      LEGACY_EMPTY_GUARDRAILS,
    )
    await rm(home, { recursive: true, force: true })
    // 再次 run():先抢救(从 staging promote)再常规迁移;家目录应恢复
    await migration.run()
    expect(existsSync(join(home, 'guardrails.md'))).toBe(true)
    expect(existsSync(stagingDir)).toBe(false) // staging 已被 promote 消费
    // 角色仍唯一
    expect(await roleRepo.listRoleRows()).toHaveLength(1)
    await rm(ws, { recursive: true, force: true })
  })

  it('B-05 消歧不超 24 字:三批超长同名目录分批迁移,显示名互不相同且总长 ≤24(含三位数安全)', async () => {
    const parents = [] as string[]
    for (let i = 0; i < 3; i++) {
      const parent = await mkdtemp(join(tmpdir(), `disambig-${i}-`))
      const dir = join(parent, '长'.repeat(30))
      await mkdir(dir, { recursive: true })
      parents.push(dir)
    }
    // 分三批迁移(每批 run 一次,检验跨次消歧计数归一)
    for (const dir of parents) {
      await seedSession(dir)
      await migration.run()
    }
    const roles = await roleRepo.listRoleRows()
    const targets = roles.filter((r) => r.displayName.startsWith('长'))
    expect(targets).toHaveLength(3)
    for (const r of targets) {
      expect([...r.displayName].length).toBeLessThanOrEqual(24)
    }
    // 三个名字互不相同(第三批不得与（2）重复——复审未闭合点)
    expect(new Set(targets.map((r) => r.displayName)).size).toBe(3)
    const names = targets.map((r) => r.displayName).sort()
    expect(names[1]).toBe('长'.repeat(18) + '（2）')
    expect(names[2]).toBe('长'.repeat(18) + '（3）')
    await Promise.all(parents.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('B-02 补:staging 根目录不存在时,缺失家目录的角色仍被重建(不短路)', async () => {
    const ws = await mkdtemp(join(tmpdir(), '无staging-'))
    await seedSession(ws)
    await migration.run()
    const roles = await roleRepo.listRoleRows()
    const home = join(dir, 'daweige', 'agents', roles[0]!.id)
    await rm(home, { recursive: true, force: true })
    await rm(join(dir, 'daweige', 'staging'), { recursive: true, force: true }) // staging 根整体不存在
    await migration.run()
    // 家目录被重建(空守则),不再永久 ROLE_HOME_BROKEN
    expect(existsSync(join(home, 'guardrails.md'))).toBe(true)
    await rm(ws, { recursive: true, force: true })
  })

  it('B-03 删除启动原子:deleting 角色必有 deletion job(beginDeletionTransaction)', async () => {
    const { RoleService } = await import('../../../src/main/roles/role-service')
    const roleService = new RoleService(dir, roleRepo)
    const ws = await mkdtemp(join(tmpdir(), '原子删-'))
    const detail = await roleService.createRole({
      displayName: '原子删',
      workspacePaths: [ws],
      primaryWorkspacePath: ws,
      templateId: 'writer',
      guardrails: '',
    })
    await roleRepo.beginDeletionTransaction(detail.summary.id, 'confirmed', [])
    const row = await roleRepo.getRoleRow(detail.summary.id)
    const job = await roleRepo.getDeletionJob(detail.summary.id)
    expect(row!.lifecycle).toBe('deleting')
    expect(job).toBeDefined() // 同事务:deleting 与 job 同时可见,无中间态
    await rm(ws, { recursive: true, force: true })
  })
})

describe('迁移:幂等与 reconciliation', () => {
  it('二次启动不重复迁移;meta 记录 completed', async () => {
    const ws = await mkdtemp(join(tmpdir(), '幂等-'))
    await seedSession(ws)
    await migration.run()
    const second = await migration.run()
    expect(second.migratedSessions).toBe(0)
    expect(second.createdRoles).toBe(0)
    expect(await roleRepo.getMeta('role_migration_v1')).toBe('completed')
    expect(await roleRepo.listRoleRows()).toHaveLength(1)
    await rm(ws, { recursive: true, force: true })
  })

  it('新增一个未绑定旧会话 → 只补该会话,不动既有角色', async () => {
    const ws1 = await mkdtemp(join(tmpdir(), '补迁A-'))
    const ws2 = await mkdtemp(join(tmpdir(), '补迁B-'))
    await seedSession(ws1)
    await migration.run()
    const rolesBefore = await roleRepo.listRoleRows()

    await seedSession(ws2)
    const second = await migration.run()
    expect(second.migratedSessions).toBe(1)
    expect(second.createdRoles).toBe(1)

    const rolesAfter = await roleRepo.listRoleRows()
    expect(rolesAfter).toHaveLength(2)
    expect(rolesAfter.find((r) => r.id === rolesBefore[0]!.id)!.updatedAt).toBe(rolesBefore[0]!.updatedAt)
    await Promise.all([rm(ws1, { recursive: true, force: true }), rm(ws2, { recursive: true, force: true })])
  })

  it('孤儿 binding 只记录不删除', async () => {
    const ws = await mkdtemp(join(tmpdir(), '孤儿-'))
    const session = await sessionRepo.create({ cwd: ws, providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
    const sessionId = (await session.getMetadata()).id
    await migration.run()
    // 直接删 pi 会话(模拟外部消失),binding 留下
    const metas = await sessionRepo.list()
    await sessionRepo.delete(metas.find((m) => m.id === sessionId)!)
    const second = await migration.run()
    expect(second.orphanBindings).toBe(1)
    // binding 仍在(不自动删)
    const bindings = await roleRepo.listBindingRows()
    expect(bindings.some((b) => b.sessionId === sessionId)).toBe(true)
    await rm(ws, { recursive: true, force: true })
  })
})
