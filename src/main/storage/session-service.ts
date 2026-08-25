import type { Session } from '@earendil-works/pi-agent-core'
import type { SqliteSessionMetadata } from '@earendil-works/pi-session-backend-sqlite-node'
import type { SessionSummary, SessionDetail } from '../../shared/domain/session'
import type { ProviderId } from '../../shared/domain/provider'
import type { RoleId } from '../../shared/domain/role'
import { readAppMeta, type DaweigeSessionAppMeta, type SessionRepository } from './session-repository'
import type { RoleRepository, SessionBindingRow } from '../roles/role-repository'
import type { RoleService } from '../roles/role-service'

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
  /** 角色层是否仍可用(迁移失败降级时置 false,内部引用不再生效,初审整改)。 */
  private rolesActive = true

  constructor(
    private readonly repository: SessionRepository,
    private readonly roleRepository?: RoleRepository,
    private readonly roleService?: RoleService,
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

    const session = await this.repository.create({
      cwd: primary.workspacePath,
      providerId: input.providerId,
      modelId: input.modelId,
    })
    const meta = await session.getMetadata()
    // pi 会话已创建、binding 写入失败:补偿删除刚创建的空会话,不留无主会话
    try {
      await this.roleRepository.bindSession({
        sessionId: meta.id,
        roleId: input.roleId,
        workspacePathSnapshot: primary.workspacePath,
        archivedAt: null,
        visibility: 'user',
        source: 'created',
      })
    } catch (err) {
      await this.repository.delete(meta).catch((delErr) => {
        console.error('[sessions] binding 写入失败后的补偿删除也失败(可能留下无主会话):', delErr instanceof Error ? delErr.message : delErr)
      })
      throw err
    }
    // binding 刚写入,直接以 roleId 装配 summary(前端按返回值更新状态,roleId 不能是 null)
    return {
      summary: toSummary(meta, 0, { roleId: input.roleId, archivedAt: null }),
      messages: [],
    }
  }

  async listSummaries(): Promise<SessionSummary[]> {
    const [metas, bindings] = await Promise.all([
      this.repository.list(),
      this.visibleBindings(),
    ])
    return metas
      .map((m) => toSummary(m, 0, bindings.get(m.id))) // 列表阶段不开会话拿 stats,避免 writer lease 开销
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async openDetail(sessionId: string): Promise<SessionDetail> {
    const session = await this.openSession(sessionId)
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
    // 无论 pi 行是否还在,binding 都幂等清理(codex 复审 S-02:
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

  async findMeta(sessionId: string): Promise<SqliteSessionMetadata | undefined> {
    const metas = await this.repository.list()
    return metas.find((m) => m.id === sessionId)
  }

  /** 打开底层 pi Session(agent 恢复/持久化用);同会话复用同一实例。 */
  async openPiSession(sessionId: string): Promise<Session<SqliteSessionMetadata>> {
    const cached = this.openSessions.get(sessionId)
    if (cached) return cached
    const session = await this.openSession(sessionId)
    this.openSessions.set(sessionId, session)
    return session
  }

  private async visibleBindings(): Promise<Map<string, SessionBindingRow>> {
    try {
      const bindings = (await this.roleRepository?.listBindingRows()) ?? []
      return new Map(
        bindings.filter((b) => b.visibility === 'user').map((b) => [b.sessionId, b]),
      )
    } catch (err) {
      // 角色库运行时读失败:会话列表降级为"无绑定"(roleId=null),绝不整体失败(初审整改)
      console.error('[sessions] 角色绑定读取失败,本次列表不显示角色归属:', err instanceof Error ? err.message : err)
      return new Map()
    }
  }

  private async bindingOf(sessionId: string): Promise<SessionBindingRow | undefined> {
    try {
      const binding = await this.roleRepository?.getBinding(sessionId)
      return binding && binding.visibility === 'user' ? binding : undefined
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

export type { DaweigeSessionAppMeta }
