import type { Session } from '@earendil-works/pi-agent-core'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import type { SessionSummary, SessionDetail } from '../../shared/domain/session'
import type { ProviderId } from '../../shared/domain/provider'
import type { RoleId } from '../../shared/domain/role'
import { readAppMeta, type DaweigeSessionAppMeta, type SessionRepository } from './session-repository'
import type { RoleRepository, SessionBindingRow } from '../roles/role-repository'
import type { RoleService } from '../roles/role-service'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import { systemManagerWorkspacePath } from '../roles/system-manager'

/**
 * 会话领域服务(M2-05/06 + 0.2.0 A3):pi Session ↔ SessionSummary/Detail 映射与 CRUD。
 * 角色化:会话必须挂在角色下(cwd=角色主挂载,渲染层不再传路径);
 * roleId/archivedAt 来自角色库 session_bindings,消息正文仍以 pi 库为权威。
 */

const DEFAULT_TITLE = '新会话'

export class SessionService {
  /**
   * 已打开的 pi Session 缓存。
   * 同一会话必须复用同一个 Session 实例:SQLite 后端有 writer lease,
   * 重复 open 同一会话会冲突/互抢;repository.close() 负责统一释放。
   */
  private readonly openSessions = new Map<string, Session<SqliteSessionMetadata>>()
  /** 并发首次打开的 single-flight 槽(openPiSession)。 */
  private readonly openingSessions = new Map<string, Promise<Session<SqliteSessionMetadata>>>()
  /** 角色层是否仍可用(迁移失败降级时置 false,内部引用不再生效,初审整改)。 */
  private rolesActive = true

  constructor(
    private readonly repository: SessionRepository,
    private readonly roleRepository?: RoleRepository,
    private readonly roleService?: RoleService,
    private readonly userDataPath?: string,
  ) {}

  /** 角色功能降级(迁移失败等):会话服务停用角色分支,回到无角色行为。 */
  deactivateRoles(): void {
    this.rolesActive = false
  }

  async create(input: {
    roleId: RoleId
    providerId: ProviderId
    modelId: string
  }): Promise<SessionDetail> {
    if (input.roleId === SYSTEM_MANAGER_ROLE_ID) {
      return this.createManagerSession(input)
    }
    if (!this.rolesActive || !this.roleRepository || !this.roleService) {
      throw new SessionCreateError('角色功能本次运行不可用(启动迁移未完成);请重启应用再试')
    }
    const role = await this.roleService.getSummary(input.roleId)
    if (role.kind === 'legacy-unresolved') {
      throw new SessionCreateError('这个角色没有找到工作文件夹,不能从这里新建会话;可先重新挂载文件夹')
    }
    if (role.archivedAt !== null) {
      throw new SessionCreateError('角色已归档,先在归档区恢复他,再开始新的会话')
    }
    if (role.lifecycle !== 'ready') {
      // 删除中/删除未完成:冻结,不再产生新会话(否则 binding 级联删后 pi 正文成孤儿)
      throw new SessionCreateError('这个角色正在删除中(或上次删除没完成),不能再新建会话;重启应用会自动续完删除')
    }
    const primary = role.mounts.find((m) => m.primary) ?? role.mounts[0]
    if (!primary) {
      throw new SessionCreateError('这个角色还没有挂载工作文件夹')
    }
    if (primary.availability !== 'available') {
      throw new SessionCreateError('工作文件夹目前不存在(可能被移动或删除),请重新挂载后再新建会话')
    }

    return this.createBoundSession({
      ...input,
      cwd: primary.workspacePath,
      visibility: 'user',
    })
  }

  /** 内置小柊用户会话:cwd 固定 system 私有 workspace,无 mounts。 */
  async createManagerSession(input: {
    readonly providerId: ProviderId
    readonly modelId: string
  }): Promise<SessionDetail> {
    if (!this.rolesActive || !this.roleRepository || !this.userDataPath) {
      throw new SessionCreateError('总管功能本次运行不可用;请重启应用再试')
    }
    const row = await this.roleRepository.getRoleRow(SYSTEM_MANAGER_ROLE_ID)
    if (!row || row.kind !== 'manager' || row.lifecycle !== 'ready' || row.archivedAt !== null) {
      throw new SessionCreateError('内置总管尚未准备好;请重启应用再试')
    }
    return this.createBoundSession({
      roleId: SYSTEM_MANAGER_ROLE_ID,
      providerId: input.providerId,
      modelId: input.modelId,
      cwd: systemManagerWorkspacePath(this.userDataPath),
      visibility: 'user',
    })
  }

  /** 后续 orchestrator 唯一的 internal 创建入口;renderer 没有对应 IPC。 */
  async createInternalSession(input: {
    readonly roleId: RoleId
    readonly workspacePath: string
    readonly providerId: ProviderId
    readonly modelId: string
  }): Promise<SessionDetail> {
    if (!this.rolesActive || !this.roleRepository) {
      throw new SessionCreateError('角色功能本次运行不可用;不能创建内部任务会话')
    }
    const role = await this.roleRepository.getRoleRow(input.roleId)
    if (!role || role.kind !== 'worker' || role.lifecycle !== 'ready' || role.archivedAt !== null) {
      throw new SessionCreateError('目标角色不可用;不能创建内部任务会话')
    }
    return this.createBoundSession({
      roleId: input.roleId,
      providerId: input.providerId,
      modelId: input.modelId,
      cwd: input.workspacePath,
      visibility: 'internal',
    })
  }

  private async createBoundSession(input: {
    readonly roleId: RoleId
    readonly cwd: string
    readonly providerId: ProviderId
    readonly modelId: string
    readonly visibility: 'user' | 'internal'
  }): Promise<SessionDetail> {
    if (!this.roleRepository) throw new SessionCreateError('角色功能本次运行不可用')
    const session = await this.repository.create({
      cwd: input.cwd,
      providerId: input.providerId,
      modelId: input.modelId,
      internal: input.visibility === 'internal',
    })
    const meta = await session.getMetadata()
    try {
      await this.roleRepository.bindSession({
        sessionId: meta.id,
        roleId: input.roleId,
        workspacePathSnapshot: input.cwd,
        archivedAt: null,
        visibility: input.visibility,
        source: 'created',
      })
    } catch (err) {
      await this.repository.delete(meta).catch((delErr) => {
        console.error(
          '[sessions] 绑定写入失败后的补偿删除也失败(可能留下无主会话):',
          delErr instanceof Error ? delErr.message : delErr,
        )
      })
      throw err
    }
    return {
      summary: toSummary(meta, 0, { roleId: input.roleId, archivedAt: null }),
      messages: [],
    }
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const [metas, bindingRows] = await Promise.all([
      this.repository.list(),
      this.bindingRowsSafe(),
    ])
    // binding 与 pi appMeta 双重判定；角色库坏掉时仍不把 internal transcript 泄漏到侧栏。
    const internalIds =
      bindingRows === null
        ? null
        : new Set(bindingRows.filter((b) => b.visibility === 'internal').map((b) => b.sessionId))
    const bindings = new Map(
      (bindingRows ?? []).filter((b) => b.visibility === 'user').map((b) => [b.sessionId, b]),
    )
    return metas
      .filter((m) => !(internalIds?.has(m.id) ?? false) && readAppMeta(m)?.internal !== true)
      .map((m) => toSummary(m, 0, bindings.get(m.id))) // 列表阶段不开会话拿 stats,避免 writer lease 开销
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async openDetail(sessionId: string): Promise<SessionDetail> {
    // 与活跃 Agent 复用同一 pi Session；另开实例会争抢 SQLite writer lease，
    // 导致 running child 的详情被上层吞错成 null。
    const session = await this.openPiSession(sessionId)
    const [meta, name, stats, binding] = await Promise.all([
      session.getMetadata(),
      session.getName(),
      session.getStats(),
      this.bindingOf(sessionId),
    ])
    const summary = toSummary({ ...meta, name: name ?? meta.name }, stats.messageCount, binding)
    // TODO(M3-04): 从 findEntriesOnBranch 恢复 ChatMessage 列表
    return { summary, messages: [] }
  }

  async rename(sessionId: string, title: string): Promise<SessionSummary> {
    const session = await this.openSession(sessionId)
    await session.setName(title)
    const [meta, binding] = await Promise.all([session.getMetadata(), this.bindingOf(sessionId)])
    return toSummary({ ...meta, name: title }, 0, binding)
  }

  async remove(sessionId: string): Promise<void> {
    const meta = await this.findMeta(sessionId)
    if (meta) {
      this.openSessions.delete(sessionId)
      await this.repository.delete(meta)
    }
    // 无论 pi 行是否还在,binding 都幂等清理(复审 S-02:
    // pi 删除成功但 binding 清理失败被吞时,不能留永久孤儿计数)
    await this.roleRepository?.deleteBinding(sessionId).catch((err) => {
      console.error('[sessions] 会话绑定清理失败(可能残留角色计数):', err instanceof Error ? err.message : err)
    })
  }

  /** 会话归档/恢复:只写角色库,不动 pi 数据与 usage。 */
  async setArchived(sessionId: string, archived: boolean): Promise<SessionSummary> {
    if (!this.roleRepository) throw new Error('角色功能未初始化')
    const binding = await this.roleRepository.getBinding(sessionId)
    if (!binding) throw new SessionNotFoundError(sessionId)
    await this.roleRepository.setSessionArchived(sessionId, archived ? Date.now() : null)
    const [meta, after] = await Promise.all([this.findMeta(sessionId), this.bindingOf(sessionId)])
    if (!meta) throw new SessionNotFoundError(sessionId)
    return toSummary(meta, 0, after)
  }

  /** 发消息前的归档拦截:已归档会话不能继续聊(前端已禁输入,这里兜底)。 */
  async assertSessionNotArchived(sessionId: string): Promise<void> {
    const binding = await this.bindingOf(sessionId)
    if (binding?.archivedAt != null) {
      throw new SessionCreateError('这条会话已经归档;想继续聊,去「归档」里先恢复它')
    }
  }

  /** 所有 renderer 发起的 session/message/workspace handler 必须先过此闸。 */
  async assertUserVisibleSession(sessionId: string): Promise<void> {
    // 即使角色功能启动降级，pi 自身的 internal 标记也必须先执行 fail-closed 闸门。
    const meta = await this.findMeta(sessionId)
    if (meta && readAppMeta(meta)?.internal === true) throw new InternalSessionAccessError()
    if (!this.rolesActive || !this.roleRepository) return
    const binding = await this.roleRepository.getBinding(sessionId)
    if (binding?.visibility === 'internal') {
      throw new InternalSessionAccessError()
    }
  }

  /** 种子服务只读 pi metadata,不打开 Session、不取 writer lease。 */
  listAllMetadata(): ReturnType<SessionRepository['list']> {
    return this.repository.list()
  }

  async findMeta(sessionId: string): Promise<SqliteSessionMetadata | undefined> {
    const metas = await this.repository.list()
    return metas.find((m) => m.id === sessionId)
  }

  /** 打开底层 pi Session(agent 恢复/持久化用);同会话复用同一实例。
   *  single-flight:并发首次打开共享同一个 pending Promise,避免两个实例争抢 writer lease(复核残余点)。 */
  async openPiSession(sessionId: string): Promise<Session<SqliteSessionMetadata>> {
    const cached = this.openSessions.get(sessionId)
    if (cached) return cached
    const pending = this.openingSessions.get(sessionId)
    if (pending) return pending
    const opening = this.openSession(sessionId)
      .then((session) => {
        this.openingSessions.delete(sessionId)
        // 并发路径可能已写入同一实例之外的胜者:以先完成者为准,后来者复用
        if (!this.openSessions.has(sessionId)) this.openSessions.set(sessionId, session)
        return this.openSessions.get(sessionId) ?? session
      })
      .catch((err: unknown) => {
        this.openingSessions.delete(sessionId)
        throw err
      })
    this.openingSessions.set(sessionId, opening)
    return opening
  }

  /** 读全部 binding 行;角色库运行时读失败返回 null(调用方降级),绝不整体抛错。 */
  private async bindingRowsSafe(): Promise<SessionBindingRow[] | null> {
    try {
      return (await this.roleRepository?.listBindingRows()) ?? []
    } catch (err) {
      // 角色库运行时读失败:会话列表降级为"无绑定"(roleId=null),绝不整体失败(初审整改)
      console.error('[sessions] 角色绑定读取失败,本次列表不显示角色归属:', err instanceof Error ? err.message : err)
      return null
    }
  }

  private async bindingOf(sessionId: string): Promise<SessionBindingRow | undefined> {
    try {
      const binding = await this.roleRepository?.getBinding(sessionId)
      if (binding && binding.visibility === 'user') return binding
      if (!binding) {
        const meta = await this.findMeta(sessionId)
        if (meta && readAppMeta(meta)?.internal === true) return undefined
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async openSession(sessionId: string): Promise<Session<SqliteSessionMetadata>> {
    const meta = await this.findMeta(sessionId)
    if (!meta) {
      throw new SessionNotFoundError(sessionId)
    }
    return this.repository.open(meta)
  }
}

function toSummary(
  m: SqliteSessionMetadata,
  messageCount: number,
  binding: Pick<SessionBindingRow, 'roleId' | 'archivedAt'> | undefined,
): SessionSummary {
  const app = readAppMeta(m)
  const providerId: ProviderId = app?.providerId ?? 'kimi-coding'
  return {
    id: m.id,
    title: m.name ?? DEFAULT_TITLE,
    workspacePath: m.cwd,
    // binding 缺失(迁移前/孤儿防御)→ null,前端归入「未分组」兜底
    roleId: binding?.roleId ?? null,
    archivedAt: binding?.archivedAt ?? null,
    providerId,
    modelId: app?.modelId ?? '',
    createdAt: m.createdAt,
    // pi metadata 只在创建时写;第一版 updatedAt 与创建时间一致(M3-04 持久化消息时再评估)
    updatedAt: app?.updatedAt ?? m.createdAt,
    messageCount,
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`会话不存在或已删除:${sessionId}`)
  }
}

export class SessionCreateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionCreateError'
  }
}

export class InternalSessionAccessError extends Error {
  constructor() {
    super('内部任务会话不能通过普通会话入口操作')
    this.name = 'InternalSessionAccessError'
  }
}

export type { DaweigeSessionAppMeta }
