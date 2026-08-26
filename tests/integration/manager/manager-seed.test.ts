import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_MANAGER_ROLE_ID } from '../../../src/shared/domain/manager'
import { RoleMigration } from '../../../src/main/roles/role-migration'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { RoleService } from '../../../src/main/roles/role-service'
import {
  ManagerSeedService,
  MANAGER_ENTRY_SESSION_META_KEY,
  systemManagerWorkspacePath,
  systemRoleHomePath,
} from '../../../src/main/roles/system-manager'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { readAppMeta } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { AgentRunRecovery } from '../../../src/main/manager/agent-run-recovery'

let userData: string
let roleRepository: RoleRepository
let sessionRepository: SessionRepository
let roleService: RoleService
let sessionService: SessionService
let seed: ManagerSeedService

const provider = { providerId: 'kimi-coding' as const, modelId: 'kimi-for-coding' }

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'manager-seed-'))
  roleRepository = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  sessionRepository = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await sessionRepository.init()
  roleService = new RoleService(userData, roleRepository, sessionRepository)
  sessionService = new SessionService(
    sessionRepository,
    roleRepository,
    roleService,
    userData,
  )
  seed = new ManagerSeedService(userData, roleRepository, sessionService)
})

afterEach(async () => {
  await sessionRepository.close()
  await roleRepository.drainAndClose()
  rmSync(userData, { recursive: true, force: true })
})

describe('ManagerSeedService', () => {
  it('空库首次种 manager、无 mounts、固定 home/cwd 和 user 入口会话', async () => {
    const bootstrap = await seed.ensure(provider)
    const row = await roleRepository.getRoleRow(SYSTEM_MANAGER_ROLE_ID)
    expect(row).toMatchObject({
      id: SYSTEM_MANAGER_ROLE_ID,
      kind: 'manager',
      displayName: '小柊',
      templateId: 'manager-built-in',
      homeRelPath: 'daweige/system/sys-xiaozhen',
    })
    expect((await roleRepository.listMountRows()).filter((m) => m.roleId === SYSTEM_MANAGER_ROLE_ID)).toEqual([])
    expect(await roleRepository.getBinding(bootstrap.entrySessionId)).toMatchObject({
      roleId: SYSTEM_MANAGER_ROLE_ID,
      visibility: 'user',
      workspacePathSnapshot: systemManagerWorkspacePath(userData),
    })
    expect(existsSync(join(systemRoleHomePath(userData), 'profile.json'))).toBe(true)
    expect(existsSync(join(systemRoleHomePath(userData), 'manager-prompt-version.json'))).toBe(true)
  })

  it('二次 ensure 不重复角色或入口会话,也不覆盖已有显示名', async () => {
    const first = await seed.ensure(provider)
    await roleRepository.updateDisplayName(SYSTEM_MANAGER_ROLE_ID, '我的小柊', Date.now())
    const second = await seed.ensure(provider)
    expect(second).toEqual(first)
    expect((await roleRepository.listRoleRows()).filter((r) => r.kind === 'manager')).toHaveLength(1)
    expect(
      (await roleRepository.listBindingRows()).filter(
        (b) => b.roleId === SYSTEM_MANAGER_ROLE_ID && b.visibility === 'user',
      ),
    ).toHaveLength(1)
    expect((await roleRepository.getRoleRow(SYSTEM_MANAGER_ROLE_ID))?.displayName).toBe('我的小柊')
  })

  it('删除最后一条 manager session 后补种并修复 meta', async () => {
    const first = await seed.ensure(provider)
    await sessionService.remove(first.entrySessionId)
    const second = await seed.ensure(provider)
    expect(second.entrySessionId).not.toBe(first.entrySessionId)
    expect(await roleRepository.getMeta(MANAGER_ENTRY_SESSION_META_KEY)).toBe(second.entrySessionId)
    expect(await sessionService.findMeta(first.entrySessionId)).toBeUndefined()
  })

  it('公共 role mutation 拒绝 system ID', async () => {
    await seed.ensure(provider)
    await expect(roleService.updateDisplayName(SYSTEM_MANAGER_ROLE_ID, '改名')).rejects.toThrow('非法角色 ID')
    await expect(roleService.updateGuardrails(SYSTEM_MANAGER_ROLE_ID, '改守则', 1)).rejects.toThrow('非法角色 ID')
    await expect(roleService.setRoleArchived(SYSTEM_MANAGER_ROLE_ID, true)).rejects.toThrow('非法角色 ID')
    await expect(roleService.getDeleteImpact(SYSTEM_MANAGER_ROLE_ID)).rejects.toThrow('非法角色 ID')
  })

  it('旧无 binding 会话先迁为 worker,再 seed manager', async () => {
    const oldWorkspace = join(userData, 'old-workspace')
    await mkdir(oldWorkspace, { recursive: true })
    const oldSession = await sessionRepository.create({ cwd: oldWorkspace, ...provider })
    const oldMeta = await oldSession.getMetadata()

    await new RoleMigration(userData, roleRepository, sessionRepository).run()
    const oldBinding = await roleRepository.getBinding(oldMeta.id)
    expect(oldBinding?.roleId).toMatch(/^agent-/)
    expect((await roleRepository.getRoleRow(oldBinding!.roleId))?.kind).toBe('worker')

    const bootstrap = await seed.ensure(provider)
    expect((await roleRepository.getBinding(oldMeta.id))?.roleId).toBe(oldBinding?.roleId)
    expect((await roleRepository.getBinding(bootstrap.entrySessionId))?.roleId).toBe(
      SYSTEM_MANAGER_ROLE_ID,
    )
  })

  it('seed 创建入口失败时不删旧会话或旧 binding,下次可重试', async () => {
    const oldWorkspace = join(userData, 'existing-workspace')
    await mkdir(oldWorkspace, { recursive: true })
    const oldSession = await sessionRepository.create({ cwd: oldWorkspace, ...provider })
    const oldMeta = await oldSession.getMetadata()
    await new RoleMigration(userData, roleRepository, sessionRepository).run()
    const oldBinding = await roleRepository.getBinding(oldMeta.id)

    const originalCreate = sessionRepository.create.bind(sessionRepository)
    sessionRepository.create = async () => {
      throw new Error('模拟 pi 会话创建失败')
    }
    await expect(seed.ensure(provider)).rejects.toThrow('模拟 pi 会话创建失败')
    sessionRepository.create = originalCreate

    expect(await sessionService.findMeta(oldMeta.id)).toBeDefined()
    expect(await roleRepository.getBinding(oldMeta.id)).toEqual(oldBinding)
    await expect(seed.ensure(provider)).resolves.toMatchObject({ roleId: SYSTEM_MANAGER_ROLE_ID })
  })

  it('internal 创建入口写 internal binding、用户列表隐藏且普通入口拒绝', async () => {
    const workspace = join(userData, 'worker-workspace')
    await mkdir(workspace, { recursive: true })
    const worker = await roleService.createRole({
      displayName: '内部测试员',
      workspacePaths: [workspace],
      primaryWorkspacePath: workspace,
      templateId: 'writer',
      guardrails: '# 角色守则',
    })
    const detail = await sessionService.createInternalSession({
      roleId: worker.summary.id,
      workspacePath: workspace,
      ...provider,
    })
    expect(await roleRepository.getBinding(detail.summary.id)).toMatchObject({
      roleId: worker.summary.id,
      visibility: 'internal',
    })
    expect(readAppMeta((await sessionService.findMeta(detail.summary.id))!)?.internal).toBe(true)
    expect((await sessionService.listSummaries()).some((s) => s.id === detail.summary.id)).toBe(false)
    await expect(sessionService.assertUserVisibleSession(detail.summary.id)).rejects.toThrow(
      '内部任务会话不能通过普通会话入口操作',
    )
  })

  it('binding 被删后 appMeta 仍隐藏 internal 会话且普通入口拒绝', async () => {
    const workspace = join(userData, 'worker-binding-lost')
    await mkdir(workspace, { recursive: true })
    const worker = await roleService.createRole({
      displayName: '兜底测试员',
      workspacePaths: [workspace],
      primaryWorkspacePath: workspace,
      templateId: 'writer',
      guardrails: '# 守则',
    })
    const detail = await sessionService.createInternalSession({
      roleId: worker.summary.id,
      workspacePath: workspace,
      ...provider,
    })
    await roleRepository.deleteBinding(detail.summary.id)

    expect((await sessionService.listSummaries()).some((item) => item.id === detail.summary.id)).toBe(false)
    await expect(sessionService.assertUserVisibleSession(detail.summary.id)).rejects.toThrow(
      '内部任务会话不能通过普通会话入口操作',
    )
  })

  it('角色库列表读取失败时仍按 pi appMeta 隐藏 internal 会话', async () => {
    const workspace = join(userData, 'worker-role-db-failure')
    await mkdir(workspace, { recursive: true })
    const worker = await roleService.createRole({
      displayName: '故障注入员',
      workspacePaths: [workspace],
      primaryWorkspacePath: workspace,
      templateId: 'writer',
      guardrails: '# 守则',
    })
    const detail = await sessionService.createInternalSession({
      roleId: worker.summary.id,
      workspacePath: workspace,
      ...provider,
    })
    const original = roleRepository.listBindingRows.bind(roleRepository)
    roleRepository.listBindingRows = async () => { throw new Error('模拟角色库读取失败') }
    try {
      expect((await sessionService.listSummaries()).some((item) => item.id === detail.summary.id)).toBe(false)
    } finally {
      roleRepository.listBindingRows = original
    }
  })

  it('binding 写失败且 pi 补偿删除失败留下的 internal 孤儿重启不迁移并由 recovery 清理', async () => {
    const workspace = join(userData, 'worker-double-failure')
    await mkdir(workspace, { recursive: true })
    const worker = await roleService.createRole({
      displayName: '补偿测试员',
      workspacePaths: [workspace],
      primaryWorkspacePath: workspace,
      templateId: 'writer',
      guardrails: '# 守则',
    })
    const originalBind = roleRepository.bindSession.bind(roleRepository)
    const originalDelete = sessionRepository.delete.bind(sessionRepository)
    roleRepository.bindSession = async () => { throw new Error('模拟 binding 写失败') }
    sessionRepository.delete = async () => { throw new Error('模拟 pi 补偿删除失败') }
    await expect(sessionService.createInternalSession({
      roleId: worker.summary.id,
      workspacePath: workspace,
      ...provider,
    })).rejects.toThrow('模拟 binding 写失败')
    roleRepository.bindSession = originalBind
    sessionRepository.delete = originalDelete

    const orphan = (await sessionRepository.list()).find((meta) => readAppMeta(meta)?.internal === true)
    expect(orphan).toBeDefined()
    await new RoleMigration(userData, roleRepository, sessionRepository).run()
    expect(await roleRepository.getBinding(orphan!.id)).toBeUndefined()
    expect((await sessionService.listSummaries()).some((item) => item.id === orphan!.id)).toBe(false)
    const recovered = await new AgentRunRecovery(roleRepository, sessionService).reconcileOnStartup()
    expect(recovered.removedOrphans).toBe(1)
    expect(await sessionService.findMeta(orphan!.id)).toBeUndefined()
  })
})
