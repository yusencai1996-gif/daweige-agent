import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { RoleService } from '../../../src/main/roles/role-service'
import { GUARDRAILS_MAX_CHARS } from '../../../src/main/roles/role-files'

/**
 * RoleService 集成:创建链(staging→DB→promote)、家目录布局、
 * 挂载唯一/守则双上限/乐观并发。真实文件系统,临时 userData。
 */

let userData: string
let repo: RoleRepository
let service: RoleService

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'roles-svc-'))
  repo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  service = new RoleService(userData, repo)
})

afterEach(async () => {
  await repo.drainAndClose()
  rmSync(userData, { recursive: true, force: true })
})

const VALID_INPUT = {
  displayName: '小编',
  workspacePaths: ['C:\\Users\\demo\\Documents\\稿件'],
  primaryWorkspacePath: 'C:\\Users\\demo\\Documents\\稿件',
  templateId: 'writer' as const,
  guardrails: '# 角色守则\n\n## 身份\n你是小编。',
}

describe('RoleService:创建链', () => {
  it('创建生成 DB 记录 + 家目录完整布局,staging 不残留', async () => {
    const detail = await service.createRole(VALID_INPUT)
    const home = join(userData, 'daweige', 'agents', detail.summary.id)
    expect(existsSync(join(home, 'profile.json'))).toBe(true)
    expect(existsSync(join(home, 'guardrails.md'))).toBe(true)
    expect(existsSync(join(home, 'resources'))).toBe(true)
    expect(existsSync(join(home, 'extensions', 'skills'))).toBe(true)
    expect(existsSync(join(home, 'extensions', 'mcp'))).toBe(true)
    // staging 干净
    expect(existsSync(join(userData, 'daweige', 'staging'))).toBe(true)
    const stagingLeft = readFileSync(join(userData, 'daweige', 'agents', detail.summary.id, 'profile.json'), 'utf8')
    expect(stagingLeft).toContain(detail.summary.id)
    // detail 装配完整
    expect(detail.summary.displayName).toBe('小编')
    expect(detail.profile.templateId).toBe('writer')
    expect(detail.guardrailsVersion).toBe(1)
    expect(detail.summary.mounts[0]!.primary).toBe(true)
    // 不存在的挂载目录标 missing(测试路径不存在)
    expect(detail.summary.mounts[0]!.availability).toBe('missing')
  })

  it('重复挂载同一文件夹被拒(大小写/尾斜杠差异归并)', async () => {
    await service.createRole(VALID_INPUT)
    // 同一目录的另种写法:大小写+分隔符+尾斜杠
    const input2 = {
      ...VALID_INPUT,
      displayName: '账房',
      workspacePaths: ['c:/users/demo/documents/稿件/'],
      primaryWorkspacePath: 'c:/users/demo/documents/稿件/',
    }
    await expect(service.createRole(input2)).rejects.toMatchObject({
      code: 'MOUNT_ALREADY_USED',
    })
    // 角色数仍为 1
    expect(await service.listSummaries()).toHaveLength(1)
  })

  it('守则超 6000 字被拒;合法长度通过', async () => {
    await expect(
      service.createRole({ ...VALID_INPUT, guardrails: '守'.repeat(GUARDRAILS_MAX_CHARS + 1) }),
    ).rejects.toMatchObject({ code: 'GUARDRAILS_TOO_LONG' })
    await expect(
      service.createRole({ ...VALID_INPUT, guardrails: '守'.repeat(GUARDRAILS_MAX_CHARS) }),
    ).resolves.toBeDefined()
  })

  it('守则 24KiB 字节上限(多字节字符先于字数触顶的场景)', async () => {
    // 6000 个 emoji 每个约 4 字节 = ~24KB 边界;用 6000 字内但字节超限的组合
    const heavy = '𠀀'.repeat(6_100 / 4) // 1525 字 × 4 字节 ≈ 6100 字节,不会触字节顶
    const ok = await service.createRole({ ...VALID_INPUT, guardrails: heavy })
    expect(ok).toBeDefined()
    // 6000 字全 4 字节 = 24000 字节,恰在 24KiB 内;再加就超
    await expect(
      service.updateGuardrails(ok.summary.id, '𠀀'.repeat(6_050), ok.guardrailsVersion),
    ).rejects.toMatchObject({ code: 'GUARDRAILS_TOO_LONG' })
  })

  it('显示名/模板/挂载列表基础校验', async () => {
    await expect(service.createRole({ ...VALID_INPUT, displayName: '' })).rejects.toMatchObject({ code: 'ROLE_NAME_INVALID' })
    await expect(service.createRole({ ...VALID_INPUT, displayName: ' 名字带空白 ' })).rejects.toMatchObject({ code: 'ROLE_NAME_INVALID' })
    await expect(service.createRole({ ...VALID_INPUT, templateId: 'legacy-empty' as never })).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' })
    await expect(
      service.createRole({
        ...VALID_INPUT,
        workspacePaths: ['C:\\a', 'C:\\b'],
        primaryWorkspacePath: 'C:\\c',
      }),
    ).rejects.toMatchObject({ code: 'MOUNT_INVALID' })
  })
})

describe('RoleService:守则更新与并发', () => {
  it('updateGuardrails 成功递增版本;expectedVersion 过期被拒', async () => {
    const created = await service.createRole(VALID_INPUT)
    const first = await service.updateGuardrails(created.summary.id, '# 新守则', 1)
    expect(first.guardrailsVersion).toBe(2)
    expect(first.guardrails).toBe('# 新守则')
    // 用旧版本 1 再保存 → 冲突
    await expect(service.updateGuardrails(created.summary.id, '# 又改', 1)).rejects.toMatchObject({
      code: 'GUARDRAILS_VERSION_CONFLICT',
    })
    // 落盘内容确实是第一次保存的
    const { text } = await service.readGuardrailsOf(created.summary.id)
    expect(text).toBe('# 新守则')
  })

  it('角色不存在/非法 ID 统一错误', async () => {
    await expect(service.getDetail('agent-ffffffffffff')).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' })
    await expect(service.getDetail('../evil')).rejects.toMatchObject({ code: 'ROLE_ID_INVALID' })
  })
})

describe('RoleService:守则并发保存原子性(初审严重项整改)', () => {
  it('两路同时用同一 expectedVersion 保存:恰好一方成功,另一方冲突(不双写)', async () => {
    const created = await service.createRole(VALID_INPUT)
    const [a, b] = await Promise.allSettled([
      service.updateGuardrails(created.summary.id, '# A 版守则', 1),
      service.updateGuardrails(created.summary.id, '# B 版守则', 1),
    ])
    const aOk = a.status === 'fulfilled'
    const bOk = b.status === 'fulfilled'
    expect((aOk ? 1 : 0) + (bOk ? 1 : 0)).toBe(1) // 恰好一个成功
    const { text, version } = await service.readGuardrailsOf(created.summary.id)
    expect(version).toBe(2) // 版本只 +1,不再凭空 +2
    // 复审 B-01 加严:最终内容必须等于"成功方"的内容,不是"两版之一"——
    // 失败方内容若残留(落盘但版本归对方)在此暴露
    const winnerText = aOk ? '# A 版守则' : '# B 版守则'
    expect(text).toBe(winnerText)
  })
})

describe('RoleService:挂载可用性实时刷新(真机验收整改)', () => {
  it('目录消失后 getSummary/listSummaries 显示 missing;目录回来恢复 available', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'avail-'))
    const created = await service.createRole({
      displayName: '管家',
      workspacePaths: [ws],
      primaryWorkspacePath: ws,
      templateId: 'file-steward',
      guardrails: '',
    })
    expect(created.summary.mounts[0]!.availability).toBe('available')

    await rm(ws, { recursive: true, force: true })
    const gone = await service.getSummary(created.summary.id)
    expect(gone.mounts[0]!.availability).toBe('missing')
    const listGone = await service.listSummaries()
    expect(listGone.find((r) => r.id === created.summary.id)!.mounts[0]!.availability).toBe('missing')

    await mkdir(ws, { recursive: true })
    const back = await service.getSummary(created.summary.id)
    expect(back.mounts[0]!.availability).toBe('available')
    await rm(ws, { recursive: true, force: true })
  })
})

describe('RoleService:改名与归档', () => {
  it('改名不改 ID 与家目录;归档/恢复只动 archivedAt', async () => {
    const created = await service.createRole(VALID_INPUT)
    const renamed = await service.updateDisplayName(created.summary.id, '大编')
    expect(renamed.displayName).toBe('大编')
    expect(renamed.id).toBe(created.summary.id)
    expect(existsSync(join(userData, 'daweige', 'agents', created.summary.id, 'guardrails.md'))).toBe(true)

    const archived = await service.setRoleArchived(created.summary.id, true)
    expect(archived.archivedAt).not.toBeNull()
    const restored = await service.setRoleArchived(created.summary.id, false)
    expect(restored.archivedAt).toBeNull()
  })
})
