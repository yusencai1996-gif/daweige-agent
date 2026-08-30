import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import type { RoleRepository } from './role-repository'
import type { SessionRepository } from '../storage/session-repository'
import { readAppMeta } from '../storage/session-repository'
import { buildProfile, LEGACY_EMPTY_GUARDRAILS } from './role-templates'
import {
  canonicalWorkspaceKey,
  cleanupStaging,
  promoteRoleHome,
  stageRoleHome,
  stagingRoot,
  normalizeKey,
} from './role-files'
import { generateRoleId } from './role-id'

/**
 * 老会话迁移(PLAN §4):启动时执行显式、版本化、幂等迁移。
 *
 * 安全边界:
 * - 对 sessions.sqlite 只调用 list()(只读,不开 Session、不取 writer lease、不改任何行);
 * - 归组结果写 roles.sqlite(事务)+ 角色家目录(staging→promote);
 * - 单组建角色失败抛 MigrationError,已提交组保留——按 session 幂等,重启续跑;
 * - 绑定指向已消失 pi 会话的孤儿只记日志,绝不自动删除。
 */

export class MigrationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface MigrationResult {
  /** 本次新绑定到角色的会话数。 */
  readonly migratedSessions: number
  /** 本次新建角色数(含 legacy-unresolved)。 */
  readonly createdRoles: number
  /** 已绑定而跳过的会话数。 */
  readonly alreadyBound: number
  /** 绑定指向已消失 pi 会话的孤儿数(仅记录)。 */
  readonly orphanBindings: number
}

interface PendingPlan {
  readonly meta: SqliteSessionMetadata
  /** canonical key;unresolved 用专用前缀。 */
  readonly key: string
  readonly cwdOriginal: string
  readonly availability: 'available' | 'missing' | 'unresolved'
}

export class RoleMigration {
  constructor(
    private readonly userDataPath: string,
    private readonly repository: RoleRepository,
    private readonly sessionRepository: SessionRepository,
  ) {}

  /** 启动迁移入口(幂等):新出现的未绑定会话补迁 + 孤儿检查。 */
  async run(): Promise<MigrationResult> {
    const [bindings, metas] = await Promise.all([
      this.repository.listBindingRows(),
      this.sessionRepository.list(),
    ])
    const bound = new Set(bindings.map((b) => b.sessionId))
    const metaIds = new Set(metas.map((m) => m.id))
    const orphanBindings = bindings.filter((b) => !metaIds.has(b.sessionId))
    if (orphanBindings.length > 0) {
      console.warn(
        `[roles] 发现 ${orphanBindings.length} 条指向已消失会话的绑定(保留不删):`,
        orphanBindings.map((b) => b.sessionId).join(','),
      )
    }

    // 独立复审 B-02:先抢救半角色(DB 已提交、家目录未 promote 就中断的)——
    // 必须在清理 staging 之前做,staging 里还留着它的家目录内容
    await this.recoverInterruptedHomes()

    // internal 是 pi 库自身的权威纵深标记。即使补偿失败留下无 binding 会话，
    // 也绝不能按旧用户会话迁移；有无 run 引用均交给启动 recovery 判定清理。
    const pending = metas.filter((m) => !bound.has(m.id) && readAppMeta(m)?.internal !== true)
    if (pending.length === 0) {
      return { migratedSessions: 0, createdRoles: 0, alreadyBound: bound.size, orphanBindings: orphanBindings.length }
    }

    // 迁移开始前清掉抢救后仍然残留的 staging(单实例锁已防并发)
    await rm(stagingRoot(this.userDataPath), { recursive: true, force: true }).catch(() => {})

    const plans = await this.classify(pending)
    const groups = new Map<string, PendingPlan[]>()
    for (const plan of plans) {
      const list = groups.get(plan.key) ?? []
      list.push(plan)
      groups.set(plan.key, list)
    }

    let migratedSessions = 0
    let createdRoles = 0
    // 同名不同目录的显示名消歧:basename → 计数;
    // 初始化吃进已有角色名并剥掉「（N）」消歧后缀归一到基础名——
    // 否则已有 名称+名称（2） 时第三批同名仍会算出 seen=2 再生成一次 名称（2）(codex 复核未闭合点)
    const nameCounts = new Map<string, number>()
    for (const existing of await this.repository.listRoleRows()) {
      const base = existing.displayName.replace(/（\d+）$/, '')
      nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1)
    }

    for (const [key, group] of groups) {
      const unresolved = key.startsWith('unresolved:')
      if (unresolved) {
        // 异常会话:每个会话一个 legacy-unresolved 角色,禁止从它新建会话
        for (const plan of group) {
          await this.createRoleWithBindings({
            kind: 'legacy-unresolved',
            templateId: 'legacy-empty',
            displayName: `未找到文件夹的旧会话-${plan.meta.id.slice(0, 6)}`,
            mounts: [],
            sessions: [{ meta: plan.meta, workspacePathSnapshot: plan.cwdOriginal, availability: 'unresolved' }],
          })
          migratedSessions += 1
          createdRoles += 1
        }
        continue
      }

      const first = group[0]!
      // 目录名截断预留消歧后缀长度:18 字+「（999）」最长 5 字=23,容纳到三位数计数
      // (独立复审 B-05:超长名无法通过删除确认的输名校验,角色会删不掉)
      const rawName = basename(resolve(first.cwdOriginal)) || first.cwdOriginal
      const dirName = [...rawName].slice(0, 18).join('')
      const availability = group.some((p) => p.availability === 'available') ? 'available' : 'missing'

      // 该目录已有角色(用户先建的角色占了同一文件夹):旧会话归入既有角色,不新建
      const existingOwnerId = await this.repository.findRoleIdByCanonicalKey(key)
      if (existingOwnerId) {
        await this.repository.transaction(() => {
          for (const plan of group) {
            this.repository.bindSessionInTransaction({
              sessionId: plan.meta.id,
              roleId: existingOwnerId,
              workspacePathSnapshot: plan.cwdOriginal,
              archivedAt: null,
              visibility: 'user',
              source: 'migration',
            })
          }
        })
        migratedSessions += group.length
        continue
      }

      const seen = (nameCounts.get(dirName) ?? 0) + 1
      nameCounts.set(dirName, seen)
      const displayName = seen === 1 ? dirName : `${dirName}（${seen}）`

      await this.createRoleWithBindings({
        kind: 'worker',
        templateId: 'legacy-empty',
        displayName,
        mounts: [
          {
            workspacePath: first.cwdOriginal,
            canonicalKey: key,
            availability,
          },
        ],
        sessions: group.map((p) => ({
          meta: p.meta,
          workspacePathSnapshot: p.cwdOriginal,
          availability: p.availability,
        })),
      })
      migratedSessions += group.length
      createdRoles += 1
    }

    await this.repository.setMeta('role_migration_v1', 'completed')
    return { migratedSessions, createdRoles, alreadyBound: bound.size, orphanBindings: orphanBindings.length }
  }

  /**
   * 抢救半角色(独立复审 B-02):DB 有角色行但家目录缺失(上轮 DB 提交后、promote 前退出)。
   * staging 里找得到该 roleId 的完整家目录 → 原样 promote;找不到 → 按模板重建空守则
   * (守则文本若在 staging 也丢了则无法恢复,记日志;角色本体与绑定保住)。
   */
  private async recoverInterruptedHomes(): Promise<void> {
    const rows = await this.repository.listRoleRows()
    const stagingDirRoot = stagingRoot(this.userDataPath)
    const { readdir, readFile } = await import('node:fs/promises')
    // staging 根不存在≠无待抢救者:DB 角色仍可能缺家目录(上轮 promote 前退出且 staging 已被清),
    // 空列表继续走"无匹配→重建空守则"分支(codex 复核 B-02 未闭合点)
    let stagingRuns: string[] = []
    try {
      stagingRuns = await readdir(stagingDirRoot)
    } catch {
      stagingRuns = []
    }
    for (const row of rows) {
      const home = join(this.userDataPath, row.homeRelPath)
      if (existsSync(home)) continue
      // 在 staging 各 run 目录里找 profile.json 的 roleId 匹配
      let recovered = false
      for (const runId of stagingRuns) {
        const candidate = join(stagingDirRoot, runId)
        try {
          const profile = JSON.parse(await readFile(join(candidate, 'profile.json'), 'utf8')) as { roleId?: string }
          if (profile.roleId !== row.id) continue
          await mkdir(dirname(home), { recursive: true })
          await rename(candidate, home)
          recovered = true
          break
        } catch {
          continue
        }
      }
      if (!recovered) {
        // staging 也丢了:按模板重建空守则(守则文本无法恢复);失败记日志,不静默
        console.warn(`[roles] 角色 ${row.displayName} 的家目录缺失且 staging 无备份,重建空守则(原守则内容丢失)`)
        try {
          const staged = await stageRoleHome(
            this.userDataPath,
            buildProfile(row.id, row.templateId as never),
            LEGACY_EMPTY_GUARDRAILS,
          )
          await rename(staged, home)
        } catch (err) {
          console.error(
            `[roles] 角色 ${row.displayName} 家目录重建失败(角色将报档案损坏,需人工检查 userData):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
  }

  /** cwd 分类:有效→canonical key;绝对但缺失→missing+词法 key;异常→unresolved。 */
  private async classify(metas: readonly SqliteSessionMetadata[]): Promise<PendingPlan[]> {
    const plans: PendingPlan[] = []
    for (const meta of metas) {
      const cwd = meta.cwd
      if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
        plans.push({ meta, key: `unresolved:${meta.id}`, cwdOriginal: cwd ?? '', availability: 'unresolved' })
        continue
      }
      // 独立复审 S-04:仅"目录不存在"(ENOENT)算 missing;
      // 权限拒绝/IO 错误等不等于不存在,按 unresolved 处理不猜
      let exists = true
      let statBroken = false
      try {
        const info = await stat(cwd)
        exists = info.isDirectory()
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          exists = false
        } else {
          statBroken = true
        }
      }
      if (statBroken) {
        plans.push({ meta, key: `unresolved:${meta.id}`, cwdOriginal: cwd, availability: 'unresolved' })
        continue
      }
      try {
        const key = await canonicalWorkspaceKey(cwd)
        plans.push({
          meta,
          key,
          cwdOriginal: cwd,
          availability: exists ? 'available' : 'missing',
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // realpath 对"存在但链路断"的目标:词法 key 兜底标 missing
          const key = normalizeKey(resolve(cwd))
          plans.push({ meta, key, cwdOriginal: cwd, availability: 'missing' })
        } else {
          plans.push({ meta, key: `unresolved:${meta.id}`, cwdOriginal: cwd, availability: 'unresolved' })
        }
      }
    }
    return plans
  }

  /** staging → DB(单事务:role+mounts+bindings) → promote;失败清 staging 并抛 MigrationError。 */
  private async createRoleWithBindings(input: {
    kind: 'worker' | 'legacy-unresolved'
    templateId: 'legacy-empty'
    displayName: string
    mounts: ReadonlyArray<{ workspacePath: string; canonicalKey: string; availability: 'available' | 'missing' | 'unresolved' }>
    sessions: ReadonlyArray<{ meta: SqliteSessionMetadata; workspacePathSnapshot: string; availability: string }>
  }): Promise<string> {
    const roleId = generateRoleId()
    const now = Date.now()
    let stagingDir: string | undefined
    try {
      stagingDir = await stageRoleHome(
        this.userDataPath,
        buildProfile(roleId, 'legacy-empty'),
        LEGACY_EMPTY_GUARDRAILS,
      )
      await this.repository.transaction(() => {
        this.repository.insertRoleInTransaction({
          role: {
            id: roleId,
            kind: input.kind,
            displayName: input.displayName,
            templateId: input.templateId,
            homeRelPath: `daweige/agents/${roleId}`,
            guardrailsRelPath: 'guardrails.md',
            createdAt: now,
            updatedAt: now,
          },
          mounts: input.mounts.map((m, i) => ({
            workspacePath: m.workspacePath,
            canonicalKey: m.canonicalKey,
            ordinal: i,
            isPrimary: i === 0,
            availability: m.availability === 'unresolved' ? 'unknown' : m.availability,
          })),
          bindings: input.sessions.map((s) => ({
            sessionId: s.meta.id,
            roleId,
            workspacePathSnapshot: s.workspacePathSnapshot,
            archivedAt: null,
            visibility: 'user' as const,
            source: 'migration' as const,
            boundAt: now,
          })),
        })
      })
      await promoteRoleHome(this.userDataPath, stagingDir, roleId)
      return roleId
    } catch (err) {
      if (stagingDir) await cleanupStaging(stagingDir).catch(() => {})
      // promote 失败但 DB 已提交:删 DB 行保持"无半角色",会话仍无绑定,下次续跑
      await this.repository.deleteRoleRow(roleId).catch(() => {})
      throw new MigrationError(
        `迁移归组失败(角色 "${input.displayName}"):${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }
}
