import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type {
  RoleDeleteImpact,
  RoleDeleteResult,
  RoleDetail,
  RoleMount,
  RoleSummary,
  RoleTemplateId,
} from '../../shared/domain'
import {
  RoleAgentRunBusyError,
  type RoleRepository,
  type RoleMountRow,
  type RoleRow,
  type RoleSessionCounts,
} from './role-repository'
import {
  ManagerCleanupBusyError,
  type ManagerCleanupService,
} from '../manager/manager-cleanup-service'
import {
  buildProfile,
  getTemplateDef,
} from './role-templates'
import {
  checkGuardrails,
  cleanupStaging,
  promoteRoleHome,
  readGuardrails,
  readProfile,
  removeRoleHome,
  roleHomePath,
  stageRoleHome,
  writeGuardrails,
  canonicalWorkspaceKey,
} from './role-files'
import { generateRoleId, isValidRoleId } from './role-id'
import type { SessionRepository } from '../storage/session-repository'

/**
 * 角色领域服务(PLAN §9 A1/A6):注册表(DB) ↔ 家目录(文件)的装配与写路径。
 * 创建/守则更新都遵循「先全部校验 → staging → DB → 提升,失败补偿」;
 * 角色删除是跨 pi 库+角色库+文件系统的可恢复状态机,不假装单事务。
 */

export type RoleErrorCode =
  | 'ROLE_NOT_FOUND'
  | 'ROLE_NAME_INVALID'
  | 'ROLE_ID_INVALID'
  | 'TEMPLATE_INVALID'
  | 'GUARDRAILS_TOO_LONG'
  | 'GUARDRAILS_VERSION_CONFLICT'
  | 'MOUNT_INVALID'
  | 'MOUNT_ALREADY_USED'
  | 'ROLE_HOME_BROKEN'
  | 'ROLE_DELETE_CONFIRM_MISMATCH'
  | 'ROLE_DELETE_IMPACT_STALE'
  | 'ROLE_DELETE_FAILED'

export class RoleError extends Error {
  constructor(
    public readonly code: RoleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RoleError'
  }
}

/** 删除执行时的外部动作(中断 agent/收尾审批卡/删 pi 会话),由接线层注入。 */
export interface RoleDeleteHooks {
  /** 中断并释放会话的活跃 agent。 */
  interruptSession(sessionId: string): void
  /** 该会话全部待确认卡按拒绝收尾并清授权。 */
  settleApprovals(sessionId: string): void
  /** 删除单条 pi 会话(含其 binding)。 */
  removeSession(sessionId: string): Promise<void>
}

export interface CreateRoleInput {
  readonly displayName: string
  readonly workspacePaths: readonly string[]
  readonly primaryWorkspacePath: string
  readonly templateId: RoleTemplateId
  readonly guardrails: string
}

export class RoleService {
  private managerCleanup: ManagerCleanupService | undefined

  constructor(
    private readonly userDataPath: string,
    private readonly repository: RoleRepository,
    /** 删除影响清单需要读 pi 会话标题;只在 getDeleteImpact/delete 使用(只读)。 */
    private readonly sessionRepository?: SessionRepository,
  ) {}

  setManagerCleanup(service: ManagerCleanupService): void {
    this.managerCleanup = service
  }

  // ---------- 读路径 ----------

  async listSummaries(): Promise<RoleSummary[]> {
    const [rows, mounts, counts] = await Promise.all([
      this.repository.listRoleRows(),
      this.repository.listMountRows(),
      this.repository.listSessionCounts(),
    ])
    const mountsByRole = new Map<string, RoleMountRow[]>()
    for (const m of mounts) {
      const list = mountsByRole.get(m.roleId) ?? []
      list.push(m)
      mountsByRole.set(m.roleId, list)
    }
    // 读路径实时刷新挂载可用性(DB 快照只在创建/迁移时打标,目录可能已被动过)
    const summaries = await Promise.all(
      rows.map(async (r) => {
        const summary = this.toSummary(r, mountsByRole.get(r.id) ?? [], counts.get(r.id))
        return { ...summary, mounts: await refreshMountsAvailability(summary.mounts) }
      }),
    )
    return summaries
  }

  async getDetail(roleId: string): Promise<RoleDetail> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const [row, mounts, counts] = await Promise.all([
      this.repository.getRoleRow(roleId),
      this.repository.listMountRows(),
      this.repository.listSessionCounts(),
    ])
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    const summary = this.toSummary(
      row,
      mounts.filter((m) => m.roleId === roleId),
      counts.get(roleId),
    )
    const home = roleHomePath(this.userDataPath, roleId)
    try {
      const [profile, guardrails] = await Promise.all([readProfile(home), readGuardrails(home)])
      return { summary, profile, guardrails, guardrailsVersion: row.guardrailsVersion }
    } catch {
      throw new RoleError('ROLE_HOME_BROKEN', '角色档案文件读取失败,可能是数据目录损坏;可尝试重新编辑守则修复')
    }
  }

  async getSummary(roleId: string): Promise<RoleSummary> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const [row, mounts, counts] = await Promise.all([
      this.repository.getRoleRow(roleId),
      this.repository.listMountRows(),
      this.repository.listSessionCounts(),
    ])
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    const summary = this.toSummary(
      row,
      mounts.filter((m) => m.roleId === roleId),
      counts.get(roleId),
    )
    return { ...summary, mounts: await refreshMountsAvailability(summary.mounts) }
  }

  /** 提示词管线/工具执行用:直接拿守则文本(不装配 detail,轻量)。 */
  async readGuardrailsOf(roleId: string): Promise<{ text: string; version: number }> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const row = await this.repository.getRoleRow(roleId)
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    const home = roleHomePath(this.userDataPath, roleId)
    try {
      return { text: await readGuardrails(home), version: row.guardrailsVersion }
    } catch {
      throw new RoleError('ROLE_HOME_BROKEN', '角色守则文件读取失败')
    }
  }

  // ---------- 写路径 ----------

  async createRole(input: CreateRoleInput): Promise<RoleDetail> {
    const displayName = input.displayName
    if (displayName.length < 1 || displayName.length > 24 || displayName !== displayName.trim()) {
      throw new RoleError('ROLE_NAME_INVALID', '角色名需 1~24 字,且首尾不带空白')
    }
    const check = checkGuardrails(input.guardrails)
    if (!check.ok) throw new RoleError('GUARDRAILS_TOO_LONG', check.message!)
    if (!getTemplateDef(input.templateId) || input.templateId === 'legacy-empty') {
      throw new RoleError('TEMPLATE_INVALID', '人设模板不合法')
    }
    if (input.workspacePaths.length < 1 || input.workspacePaths.length > 8) {
      throw new RoleError('MOUNT_INVALID', '工作文件夹需 1~8 个')
    }
    if (!input.workspacePaths.includes(input.primaryWorkspacePath)) {
      throw new RoleError('MOUNT_INVALID', '主工作文件夹必须在挂载列表内')
    }

    // 挂载规范化 + 唯一性(一个文件夹只能挂一个角色)
    const mounts: Array<Omit<RoleMountRow, 'roleId'>> = []
    const seenKeys = new Set<string>()
    for (const [index, p] of input.workspacePaths.entries()) {
      const key = await canonicalWorkspaceKey(p)
      if (seenKeys.has(key)) {
        throw new RoleError('MOUNT_INVALID', '挂载列表里有重复的文件夹')
      }
      seenKeys.add(key)
      const owner = await this.repository.findRoleIdByCanonicalKey(key)
      if (owner) {
        throw new RoleError('MOUNT_ALREADY_USED', '这个文件夹已经被别的角色使用了;一个文件夹只挂一位伙伴')
      }
      mounts.push({
        workspacePath: p,
        canonicalKey: key,
        ordinal: index,
        isPrimary: p === input.primaryWorkspacePath,
        availability: await checkAvailability(p),
      })
    }

    // staging → DB → promote;任一步失败补偿,不留半角色
    const now = Date.now()
    let roleId = generateRoleId()
    let stagingDir: string | undefined
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          stagingDir = await stageRoleHome(
            this.userDataPath,
            buildProfile(roleId, input.templateId),
            input.guardrails,
          )
          await this.repository.insertRole({
            role: {
              id: roleId,
              kind: 'worker',
              displayName,
              templateId: input.templateId,
              homeRelPath: `daweige/agents/${roleId}`,
              guardrailsRelPath: 'guardrails.md',
              createdAt: now,
              updatedAt: now,
            },
            mounts,
          })
          break
        } catch (err) {
          if (stagingDir) await cleanupStaging(stagingDir).catch(() => {})
          stagingDir = undefined
          // roleId 或 canonical_key 碰撞:换 ID 重试;其余错误直接抛
          const msg = err instanceof Error ? err.message : String(err)
          if (attempt < 2 && /UNIQUE/i.test(msg)) {
            roleId = generateRoleId()
            continue
          }
          throw err
        }
      }
      if (!stagingDir) throw new Error('角色创建重试耗尽')
      await promoteRoleHome(this.userDataPath, stagingDir, roleId)
    } catch (err) {
      // DB 已写但家目录提升失败:回滚 DB 行+清 staging,角色不存在
      if (stagingDir) await cleanupStaging(stagingDir).catch(() => {})
      await this.repository.deleteRoleRow(roleId).catch(() => {})
      throw err
    }
    return this.getDetail(roleId)
  }

  async updateDisplayName(roleId: string, displayName: string): Promise<RoleSummary> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    if (displayName.length < 1 || displayName.length > 24 || displayName !== displayName.trim()) {
      throw new RoleError('ROLE_NAME_INVALID', '角色名需 1~24 字,且首尾不带空白')
    }
    const row = await this.repository.getRoleRow(roleId)
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    await this.repository.updateDisplayName(roleId, displayName, Date.now())
    return this.getSummary(roleId)
  }

  /** 守则更新(UI 保存与 AI 工具共用):乐观并发 + 字数校验 + 原子写 + 版本递增。 */
  async updateGuardrails(
    roleId: string,
    guardrails: string,
    expectedVersion: number,
  ): Promise<RoleDetail> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const check = checkGuardrails(guardrails)
    if (!check.ok) throw new RoleError('GUARDRAILS_TOO_LONG', check.message!)
    const row = await this.repository.getRoleRow(roleId)
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    if (row.guardrailsVersion !== expectedVersion) {
      throw new RoleError(
        'GUARDRAILS_VERSION_CONFLICT',
        '守则刚被改过,页面已重新加载最新版;请看过一眼后再保存',
      )
    }
    const home = roleHomePath(this.userDataPath, roleId)
    // codex 复审 B-01:读原文+文件替换+条件递增+失败恢复,全在同一队列槽内原子执行——
    // "原文"在槽内读取(不受并发方写入干扰),最终落盘内容恒等于版本胜出方
    const bumped = await this.repository.runGuardrailsUpdate(
      roleId,
      expectedVersion,
      Date.now(),
      async () => {
        const original = await readGuardrails(home).catch(() => '')
        await writeGuardrails(home, guardrails)
        return () => writeGuardrails(home, original)
      },
    )
    if (!bumped) {
      throw new RoleError(
        'GUARDRAILS_VERSION_CONFLICT',
        '守则刚被改过,页面已重新加载最新版;请看过一眼后再保存',
      )
    }
    return this.getDetail(roleId)
  }

  // ---------- 归档(A6 补忙碌检查;基础读写在此)----------

  async setRoleArchived(roleId: string, archived: boolean): Promise<RoleSummary> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const row = await this.repository.getRoleRow(roleId)
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    if (archived) {
      try {
        const at = Date.now()
        await this.repository.archiveRoleIfIdle(roleId, at, at)
      } catch (error) {
        if (error instanceof RoleAgentRunBusyError) throw new ManagerCleanupBusyError(error.message)
        throw error
      }
      await this.managerCleanup?.cleanupTargetRole(roleId)
    } else {
      await this.repository.setRoleArchived(roleId, null, Date.now())
    }
    return this.getSummary(roleId)
  }

  /** 角色的全部用户可见会话 ID(忙碌检查/删除影响用)。 */
  async listSessionIdsOfRole(roleId: string): Promise<readonly string[]> {
    const bindings = await this.repository.listBindingRows()
    return bindings.filter((b) => b.roleId === roleId && b.visibility === 'user').map((b) => b.sessionId)
  }

  // ---------- 删除(A6:影响清单 + 可恢复状态机)----------

  /** 影响清单:标题最多 5 条;impactVersion=roleId+updatedAt+排序 sessionIds 指纹。 */
  async getDeleteImpact(roleId: string): Promise<RoleDeleteImpact> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const [row, sessionIds, piMetas] = await Promise.all([
      this.repository.getRoleRow(roleId),
      this.listSessionIdsOfRole(roleId),
      this.sessionRepository?.list() ?? Promise.resolve([]),
    ])
    if (!row) throw new RoleError('ROLE_NOT_FOUND', '角色不存在或已被删除')
    const titleById = new Map(
      piMetas.map((m) => [m.id, typeof m.name === 'string' && m.name.length > 0 ? m.name : '新会话']),
    )
    const sessionTitles = sessionIds
      .map((id) => titleById.get(id) ?? '新会话')
      .slice(0, 5)
    return {
      roleId,
      displayName: row.displayName,
      sessionCount: sessionIds.length,
      sessionTitles,
      homePath: `daweige/agents/${roleId}`,
      impactVersion: this.computeImpactVersion(roleId, row.updatedAt, sessionIds),
    }
  }

  private computeImpactVersion(roleId: string, updatedAt: number, sessionIds: readonly string[]): string {
    const sorted = [...sessionIds].sort().join(',')
    return createHash('sha256').update(`${roleId}:${updatedAt}:${sorted}`).digest('hex').slice(0, 16)
  }

  /**
   * 执行删除(PLAN §5.3 顺序):确认校验 → deleting+job → 中断/收尾 → 幂等删会话
   * → 家目录(最后删,失败时守则档案仍在) → 事务清注册行。
   * 中途失败:角色留 delete_failed + job 记录剩余,重启续跑 resumeDeletionJobs。
   */
  async deleteRole(
    roleId: string,
    input: { confirmDisplayName: string; impactVersion: string; deleteSessions: true },
    hooks: RoleDeleteHooks,
  ): Promise<RoleDeleteResult> {
    if (!isValidRoleId(roleId)) throw new RoleError('ROLE_ID_INVALID', '非法角色 ID')
    const impact = await this.getDeleteImpact(roleId)
    if (impact.displayName !== input.confirmDisplayName) {
      throw new RoleError('ROLE_DELETE_CONFIRM_MISMATCH', '输入的角色名和当前名字不一致,请核对后再删')
    }
    if (impact.impactVersion !== input.impactVersion) {
      throw new RoleError(
        'ROLE_DELETE_IMPACT_STALE',
        '角色的信息刚发生过变化,影响清单已刷新;请重新确认后再删',
      )
    }
    await this.managerCleanup?.assertTargetRoleIdle(roleId)
    const userSessionIds = await this.listSessionIdsOfRole(roleId)
    const internalSessionIds = await this.managerCleanup?.internalSessionIdsForRole(roleId) ?? []
    const sessionIds = [...new Set([...userSessionIds, ...internalSessionIds])]
    return this.executeDeletion(roleId, sessionIds, hooks)
  }

  /** 已确认 job 的幂等续跑(启动恢复/重试);跳过确认校验,直接从剩余会话继续。
   *  单个 job 失败只记日志继续下一个——续跑失败绝不能禁用整个角色功能或阻断其他角色。 */
  async resumeDeletionJobs(hooks: RoleDeleteHooks): Promise<readonly RoleDeleteResult[]> {
    const jobs = await this.repository.listDeletionJobs()
    const results: RoleDeleteResult[] = []
    for (const job of jobs) {
      try {
        const remaining = job.pendingSessionIds
        results.push(await this.executeDeletion(job.roleId, remaining, hooks))
      } catch (err) {
        console.error(
          `[roles] 角色 ${job.roleId} 的删除续跑失败(保留 delete_failed 状态,下次启动再试):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    return results
  }

  private async executeDeletion(
    roleId: string,
    sessionIds: readonly string[],
    hooks: RoleDeleteHooks,
  ): Promise<RoleDeleteResult> {
    const deletedSessionIds: string[] = []
    try {
      // codex 复审 B-03:lifecycle=deleting 与 job 首记同事务——
      // 两步之间退出不再产生"deleting 但无 job"的永不续跑状态
      await this.repository.beginDeletionTransaction(roleId, 'confirmed', sessionIds)
      // 中断所有子会话 agent、拒绝收尾其待确认卡
      for (const sessionId of sessionIds) {
        hooks.interruptSession(sessionId)
        hooks.settleApprovals(sessionId)
      }
      // 幂等删除 pi 会话(SessionService.remove 幂等且连带删 binding)
      const pending = [...sessionIds]
      for (const sessionId of sessionIds) {
        await hooks.removeSession(sessionId)
        deletedSessionIds.push(sessionId)
        pending.splice(pending.indexOf(sessionId), 1)
        await this.repository.upsertDeletionJob({
          roleId,
          impactVersion: 'confirmed',
          pendingSessionIds: pending,
          phase: 'delete-sessions',
        })
      }
      // 家目录最后删:会话删除失败时守则与档案仍保留
      await removeRoleHome(this.userDataPath, roleId)
      // 收尾:事务级联清掉 binding 残留/role/job
      await this.repository.deleteRoleRow(roleId)
      return { deletedRoleId: roleId, deletedSessionIds }
    } catch (err) {
      if (err instanceof RoleAgentRunBusyError) {
        throw new ManagerCleanupBusyError(err.message)
      }
      await this.repository.setRoleLifecycle(roleId, 'delete_failed', Date.now()).catch(() => {})
      await this.repository
        .upsertDeletionJob({
          roleId,
          impactVersion: 'confirmed',
          pendingSessionIds: sessionIds.filter((id) => !deletedSessionIds.includes(id)),
          phase: 'delete-failed',
          lastError: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {})
      console.error(
        `[roles] 角色 ${roleId} 删除中断(底层原因只记本地日志):`,
        err instanceof Error ? err.message : String(err),
      )
      throw new RoleError(
        'ROLE_DELETE_FAILED',
        `删除没有全部完成:已删 ${deletedSessionIds.length} 个会话。角色已标记为「删除未完成」,重启应用会自动继续;也可稍后重试。`,
      )
    }
  }

  // ---------- 内部 ----------

  private toSummary(
    row: RoleRow,
    mounts: readonly RoleMountRow[],
    counts?: RoleSessionCounts,
  ): RoleSummary {
    return {
      id: row.id,
      kind: row.kind,
      displayName: row.displayName,
      templateId: row.templateId as RoleSummary['templateId'],
      mounts: [...mounts]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(
          (m): RoleMount => ({
            workspacePath: m.workspacePath,
            primary: m.isPrimary,
            availability: m.availability,
          }),
        ),
      archivedAt: row.archivedAt,
      lifecycle: row.lifecycle,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sessionCount: counts?.sessionCount ?? 0,
      activeSessionCount: counts?.activeSessionCount ?? 0,
    }
  }
}

/** 读路径实时刷新挂载可用性:DB 快照可能过期(目录被挪走/删掉),警示与建会话守卫都依赖实时值。 */
async function refreshMountsAvailability(mounts: readonly RoleMount[]): Promise<RoleMount[]> {
  return Promise.all(
    mounts.map(async (m) => ({ ...m, availability: await checkAvailability(m.workspacePath) })),
  )
}

async function checkAvailability(p: string): Promise<RoleMount['availability']> {
  try {
    const info = await stat(p)
    return info.isDirectory() ? 'available' : 'missing'
  } catch {
    return 'missing'
  }
}
