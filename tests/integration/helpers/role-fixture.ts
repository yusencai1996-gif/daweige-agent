import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoleRepository } from '../../../src/main/roles/role-repository'
import { RoleService } from '../../../src/main/roles/role-service'

/**
 * 角色化测试 fixture:一个临时 userData + 角色库 + 一位已就绪的 worker 角色。
 * 供 SessionService/AgentService 等集成测试注入(0.2.0 会话必须挂在角色下)。
 */

export interface RoleFixture {
  readonly userDataDir: string
  readonly roleRepository: RoleRepository
  readonly roleService: RoleService
  readonly roleId: string
  /** 角色挂载的真实工作目录。 */
  readonly workspaceDir: string
  close(): void
}

export async function createRoleFixture(displayName = '测试小编'): Promise<RoleFixture> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'role-fx-'))
  const roleRepository = new RoleRepository(join(userDataDir, 'data', 'roles.sqlite'))
  const roleService = new RoleService(userDataDir, roleRepository)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'role-ws-'))
  const detail = await roleService.createRole({
    displayName,
    workspacePaths: [workspaceDir],
    primaryWorkspacePath: workspaceDir,
    templateId: 'writer',
    guardrails: '# 角色守则\n\n## 身份\n你是测试角色。',
  })
  return {
    userDataDir,
    roleRepository,
    roleService,
    roleId: detail.summary.id,
    workspaceDir,
    async close() {
      await roleRepository.drainAndClose()
    },
  }
}
