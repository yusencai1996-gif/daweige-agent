import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/domain/provider'
import {
  SYSTEM_MANAGER_ROLE_ID,
  type ManagerBootstrap,
} from '../../shared/domain/manager'
import type { RoleProfile } from '../../shared/domain/role'
import type { SessionService } from '../storage/session-service'
import type { RoleRepository, RoleRow } from './role-repository'

/** 小柊的内部种子常量;不经过公共 role CRUD。 */
export const SYSTEM_MANAGER_DISPLAY_NAME = '小柊'
export const SYSTEM_MANAGER_TEMPLATE_ID = 'manager-built-in' as const
export const SYSTEM_MANAGER_HOME_REL_PATH = 'daweige/system/sys-xiaozhen'
export const SYSTEM_MANAGER_GUARDRAILS_REL_PATH = 'manager-prompt.md'
export const SYSTEM_MANAGER_PROMPT_VERSION = 1
export const MANAGER_ENTRY_SESSION_META_KEY = 'manager_entry_session_id'

/** 固定 system 目录 helper;与 worker roleHomePath/isValidRoleId 完全分离。 */
export function systemRoleHomePath(userDataPath: string): string {
  return join(userDataPath, 'daweige', 'system', SYSTEM_MANAGER_ROLE_ID)
}

export function systemManagerWorkspacePath(userDataPath: string): string {
  return join(systemRoleHomePath(userDataPath), 'workspace')
}

export interface ManagerSeedInput {
  readonly providerId: ProviderId
  readonly modelId: string
}

/**
 * 启动幂等种子:固定角色行 + system home + 至少一条未归档 user manager 会话。
 * 不改已有显示名;跨 roles/pi 两库只做补写,任一步失败都不删除旧会话。
 */
export class ManagerSeedService {
  constructor(
    private readonly userDataPath: string,
    private readonly roleRepository: RoleRepository,
    private readonly sessionService: SessionService,
    /** 0.4.0 A:resolver 在场=工作区可能已迁离默认位置,不再强制 mkdir 默认 workspace。 */
    private readonly hasWorkspaceOverride?: () => boolean,
  ) {}

  async ensure(input: ManagerSeedInput): Promise<ManagerBootstrap> {
    const existing = await this.roleRepository.getRoleRow(SYSTEM_MANAGER_ROLE_ID)
    if (existing) {
      assertSystemManagerRow(existing)
    } else {
      await ensureSystemHome(this.userDataPath)
      const now = Date.now()
      await this.roleRepository.insertRole({
        role: {
          id: SYSTEM_MANAGER_ROLE_ID,
          kind: 'manager',
          displayName: SYSTEM_MANAGER_DISPLAY_NAME,
          templateId: SYSTEM_MANAGER_TEMPLATE_ID,
          homeRelPath: SYSTEM_MANAGER_HOME_REL_PATH,
          guardrailsRelPath: SYSTEM_MANAGER_GUARDRAILS_REL_PATH,
          createdAt: now,
          updatedAt: now,
        },
        mounts: [],
      })
    }
    // 角色行已存在但上次可能在建 home 前后中断;每次都幂等补齐。
    // 0.4.0 A:工作区已迁离(有覆盖)时只补 home 内的档案文件,不在 C 盘重建 workspace 空壳。
    await ensureSystemHome(this.userDataPath, this.hasWorkspaceOverride?.() === true)

    const [bindings, metas, rememberedEntry] = await Promise.all([
      this.roleRepository.listBindingRows(),
      this.sessionService.listAllMetadata(),
      this.roleRepository.getMeta(MANAGER_ENTRY_SESSION_META_KEY),
    ])
    const metaIds = new Set(metas.map((meta) => meta.id))
    const activeManagerBindings = bindings
      .filter(
        (binding) =>
          binding.roleId === SYSTEM_MANAGER_ROLE_ID &&
          binding.visibility === 'user' &&
          binding.archivedAt === null &&
          metaIds.has(binding.sessionId),
      )
      .sort((a, b) => b.boundAt - a.boundAt || b.sessionId.localeCompare(a.sessionId))

    const rememberedIsUsable =
      rememberedEntry !== undefined &&
      activeManagerBindings.some((binding) => binding.sessionId === rememberedEntry)
    let entrySessionId = rememberedIsUsable
      ? rememberedEntry
      : activeManagerBindings[0]?.sessionId

    if (!entrySessionId) {
      const detail = await this.sessionService.createManagerSession(input)
      entrySessionId = detail.summary.id
    }
    if (rememberedEntry !== entrySessionId) {
      await this.roleRepository.setMeta(MANAGER_ENTRY_SESSION_META_KEY, entrySessionId)
    }
    return { roleId: SYSTEM_MANAGER_ROLE_ID, entrySessionId }
  }
}

function assertSystemManagerRow(row: RoleRow): void {
  if (
    row.id !== SYSTEM_MANAGER_ROLE_ID ||
    row.kind !== 'manager' ||
    row.templateId !== SYSTEM_MANAGER_TEMPLATE_ID ||
    row.homeRelPath !== SYSTEM_MANAGER_HOME_REL_PATH ||
    row.guardrailsRelPath !== SYSTEM_MANAGER_GUARDRAILS_REL_PATH
  ) {
    throw new Error('内置总管角色记录与固定定义不一致,已停止种子修复以免覆盖用户数据')
  }
}

async function ensureSystemHome(
  userDataPath: string,
  workspaceMigratedAway = false,
): Promise<void> {
  const home = systemRoleHomePath(userDataPath)
  if (!workspaceMigratedAway) {
    await mkdir(systemManagerWorkspacePath(userDataPath), { recursive: true })
  }
  const profile: RoleProfile = {
    schemaVersion: 1,
    roleId: SYSTEM_MANAGER_ROLE_ID,
    templateId: SYSTEM_MANAGER_TEMPLATE_ID,
    personaSummary: '大微阁内置总管,负责梳理任务并协调专业角色。',
    capabilityTags: ['任务梳理', '角色调度', '结果验收'],
  }
  await writeIfMissing(join(home, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`)
  await writeIfMissing(
    join(home, SYSTEM_MANAGER_GUARDRAILS_REL_PATH),
    '# 小柊内置提示词\n\n此文件由大微阁版本管理,不通过公共守则接口编辑。\n',
  )
  await writeFile(
    join(home, 'manager-prompt-version.json'),
    `${JSON.stringify({ schemaVersion: 1, promptVersion: SYSTEM_MANAGER_PROMPT_VERSION }, null, 2)}\n`,
    'utf8',
  )
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch((writeErr) => {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr
    })
  }
}
