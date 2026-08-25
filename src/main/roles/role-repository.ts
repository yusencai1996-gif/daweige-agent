import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 角色库(PLAN §2.3):userData/data/roles.sqlite,大微阁应用权威库。
 * 与 pi 的 sessions.sqlite 完全隔离——本库管角色注册/挂载/绑定/归档/删除进度;
 * 会话正文仍归 pi。所有读写过同一 Promise 串行队列(UsageStore 同款模式)。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL
                       CHECK (kind IN ('worker', 'manager', 'legacy-unresolved')),
  display_name         TEXT NOT NULL,
  template_id          TEXT NOT NULL,
  home_rel_path        TEXT NOT NULL UNIQUE,
  guardrails_rel_path  TEXT NOT NULL,
  guardrails_version   INTEGER NOT NULL DEFAULT 1,
  lifecycle            TEXT NOT NULL DEFAULT 'ready'
                       CHECK (lifecycle IN ('ready', 'deleting', 'delete_failed')),
  archived_at          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS role_mounts (
  role_id              TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  workspace_path       TEXT NOT NULL,
  canonical_key        TEXT NOT NULL,
  ordinal              INTEGER NOT NULL,
  is_primary           INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  availability         TEXT NOT NULL
                       CHECK (availability IN ('available', 'missing', 'unknown')),
  PRIMARY KEY (role_id, canonical_key),
  UNIQUE (canonical_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_bindings (
  session_id           TEXT PRIMARY KEY,
  role_id              TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  workspace_path_snapshot TEXT NOT NULL,
  archived_at          INTEGER,
  visibility           TEXT NOT NULL DEFAULT 'user'
                       CHECK (visibility IN ('user', 'internal')),
  source               TEXT NOT NULL
                       CHECK (source IN ('created', 'migration', 'repair')),
  bound_at             INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_session_bindings_role
  ON session_bindings(role_id, visibility, archived_at);

CREATE TABLE IF NOT EXISTS role_deletion_jobs (
  role_id              TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
  impact_version       TEXT NOT NULL,
  pending_session_ids  TEXT NOT NULL,
  phase                TEXT NOT NULL,
  last_error           TEXT,
  updated_at           INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS registry_meta (
  key                  TEXT PRIMARY KEY,
  value                TEXT NOT NULL
) WITHOUT ROWID;
`

export interface RoleRow {
  readonly id: string
  readonly kind: 'worker' | 'manager' | 'legacy-unresolved'
  readonly displayName: string
  readonly templateId: string
  readonly homeRelPath: string
  readonly guardrailsRelPath: string
  readonly guardrailsVersion: number
  readonly lifecycle: 'ready' | 'deleting' | 'delete_failed'
  readonly archivedAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RoleMountRow {
  readonly roleId: string
  readonly workspacePath: string
  readonly canonicalKey: string
  readonly ordinal: number
  readonly isPrimary: boolean
  readonly availability: 'available' | 'missing' | 'unknown'
}

export interface SessionBindingRow {
  readonly sessionId: string
  readonly roleId: string
  readonly workspacePathSnapshot: string
  readonly archivedAt: number | null
  readonly visibility: 'user' | 'internal'
  readonly source: 'created' | 'migration' | 'repair'
  readonly boundAt: number
}

export interface DeletionJobRow {
  readonly roleId: string
  readonly impactVersion: string
  readonly pendingSessionIds: readonly string[]
  readonly phase: string
  readonly lastError: string | null
  readonly updatedAt: number
}

export interface InsertRoleInput {
  readonly role: Omit<RoleRow, 'lifecycle' | 'guardrailsVersion' | 'archivedAt'>
  readonly mounts: readonly Omit<RoleMountRow, 'roleId'>[]
  readonly bindings?: readonly Omit<SessionBindingRow, 'roleId'>[]
}

export interface RoleSessionCounts {
  readonly sessionCount: number
  readonly activeSessionCount: number
}

export class RoleRepository {
  private readonly db: DatabaseSync
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  /** 事务回调进行中标记:回调内误调 enqueue 方法会死锁,直接抛错(批1初审建议)。 */
  private inTransaction = false

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  /** 读写统一串行队列;显式事务块用它包,保证队列一致快照。 */
  private enqueue<T>(op: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('roles 库已关闭(应用退出中),本次写入放弃'))
    }
    if (this.inTransaction) {
      return Promise.reject(new Error('roles 库事务回调内不能再调用排队方法(会死锁);请用 *InTransaction 同步变体'))
    }
    const next = this.chain.then(op, op)
    this.chain = next.catch(() => {})
    return next
  }

  /** 异步版队列槽(如守则保存的"写文件+条件递增"原子块)。 */
  private enqueueAsync<T>(op: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('roles 库已关闭(应用退出中),本次写入放弃'))
    }
    if (this.inTransaction) {
      return Promise.reject(new Error('roles 库事务回调内不能再调用排队方法(会死锁);请用 *InTransaction 同步变体'))
    }
    const next = this.chain.then(op, op)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  transaction<T>(fn: () => T): Promise<T> {
    return this.enqueue(() => {
      if (this.inTransaction) throw new Error('roles 库事务不能嵌套')
      this.db.exec('BEGIN IMMEDIATE')
      this.inTransaction = true
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (err) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // 连接已坏时 ROLLBACK 可能失败;保留原始错误
        }
        throw err
      } finally {
        this.inTransaction = false
      }
    })
  }

  // ---------- roles ----------

  insertRole(input: InsertRoleInput): Promise<void> {
    return this.transaction(() => this.insertRoleInTransaction(input))
  }

  /**
   * 事务体内同步写入(不 enqueue):role + mounts + 可选 bindings 一次落库。
   * 仅供 migration 等已经在 transaction() 回调里的调用方使用,
   * 在队列外直接调用会绕开串行互斥。
   */
  insertRoleInTransaction(input: InsertRoleInput): void {
    const r = input.role
    this.db
      .prepare(
        `INSERT INTO roles (id, kind, display_name, template_id, home_rel_path,
           guardrails_rel_path, guardrails_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(r.id, r.kind, r.displayName, r.templateId, r.homeRelPath, r.guardrailsRelPath, r.createdAt, r.updatedAt)
    const mount = this.db.prepare(
      `INSERT INTO role_mounts (role_id, workspace_path, canonical_key, ordinal, is_primary, availability)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const m of input.mounts) {
      mount.run(r.id, m.workspacePath, m.canonicalKey, m.ordinal, m.isPrimary ? 1 : 0, m.availability)
    }
    const bind = this.db.prepare(
      `INSERT OR IGNORE INTO session_bindings
         (session_id, role_id, workspace_path_snapshot, archived_at, visibility, source, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const b of input.bindings ?? []) {
      bind.run(b.sessionId, r.id, b.workspacePathSnapshot, b.archivedAt, b.visibility, b.source, b.boundAt)
    }
  }

  listRoleRows(): Promise<RoleRow[]> {
    return this.enqueue(() => {
      const rows = this.db.prepare('SELECT * FROM roles ORDER BY created_at ASC, id ASC').all() as Record<string, unknown>[]
      return rows.map(mapRoleRow)
    })
  }

  getRoleRow(roleId: string): Promise<RoleRow | undefined> {
    return this.enqueue(() => {
      const row = this.db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as Record<string, unknown> | undefined
      return row ? mapRoleRow(row) : undefined
    })
  }

  updateDisplayName(roleId: string, displayName: string, updatedAt: number): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('UPDATE roles SET display_name = ?, updated_at = ? WHERE id = ?').run(
        displayName,
        updatedAt,
        roleId,
      )
    })
  }

  updateGuardrailsVersion(roleId: string, version: number, updatedAt: number): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('UPDATE roles SET guardrails_version = ?, updated_at = ? WHERE id = ?').run(
        version,
        updatedAt,
        roleId,
      )
    })
  }

  /**
   * 原子乐观并发:仅当当前版本等于 expected 时递增;返回是否命中。
   * 消除 check-then-act 窗口(UI 保存与 AI 改守则工具并发时不再双写,初审严重项整改)。
   */
  bumpGuardrailsVersionIf(roleId: string, expected: number, updatedAt: number): Promise<boolean> {
    return this.enqueue(() => {
      const result = this.db
        .prepare(
          `UPDATE roles SET guardrails_version = guardrails_version + 1, updated_at = ?
           WHERE id = ? AND guardrails_version = ?`,
        )
        .run(updatedAt, roleId, expected) as { changes: number | bigint }
      return Number(result.changes) === 1
    })
  }

  /**
   * 守则保存的完整原子块(codex 复审 B-01):文件替换与条件递增在同一队列槽内串行执行;
   * 版本未命中(并发方已胜)时恢复原文,保证"最终落盘内容=版本胜出方"。
   */
  runGuardrailsUpdate(
    roleId: string,
    expectedVersion: number,
    updatedAt: number,
    /** 队列槽内执行:读原文→写新文,返回"恢复原文"函数(供版本未命中时回滚)。 */
    perform: () => Promise<() => Promise<void>>,
  ): Promise<boolean> {
    return this.enqueueAsync(async () => {
      const restore = await perform()
      const result = this.db
        .prepare(
          `UPDATE roles SET guardrails_version = guardrails_version + 1, updated_at = ?
           WHERE id = ? AND guardrails_version = ?`,
        )
        .run(updatedAt, roleId, expectedVersion) as { changes: number | bigint }
      const hit = Number(result.changes) === 1
      if (!hit) {
        await restore().catch(() => {}) // 恢复失败只剩版本不一致,下轮读取自愈
      }
      return hit
    })
  }

  /** 删除启动的事务原子块(codex 复审 B-03):lifecycle=deleting 与 job 初始记录同事务。 */
  beginDeletionTransaction(
    roleId: string,
    impactVersion: string,
    pendingSessionIds: readonly string[],
  ): Promise<void> {
    return this.transaction(() => {
      const now = Date.now()
      this.db
        .prepare(`UPDATE roles SET lifecycle = 'deleting', updated_at = ? WHERE id = ?`)
        .run(now, roleId)
      this.db
        .prepare(
          `INSERT INTO role_deletion_jobs (role_id, impact_version, pending_session_ids, phase, last_error, updated_at)
           VALUES (?, ?, ?, 'interrupt', NULL, ?)
           ON CONFLICT(role_id) DO UPDATE SET
             impact_version = excluded.impact_version,
             pending_session_ids = excluded.pending_session_ids,
             phase = excluded.phase,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(roleId, impactVersion, JSON.stringify(pendingSessionIds), now)
    })
  }

  setRoleArchived(roleId: string, archivedAt: number | null, updatedAt: number): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('UPDATE roles SET archived_at = ?, updated_at = ? WHERE id = ?').run(
        archivedAt,
        updatedAt,
        roleId,
      )
    })
  }

  setRoleLifecycle(roleId: string, lifecycle: RoleRow['lifecycle'], updatedAt: number): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('UPDATE roles SET lifecycle = ?, updated_at = ? WHERE id = ?').run(lifecycle, updatedAt, roleId)
    })
  }

  deleteRoleRow(roleId: string): Promise<void> {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM roles WHERE id = ?').run(roleId)
    })
  }

  // ---------- mounts ----------

  listMountRows(): Promise<RoleMountRow[]> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare('SELECT * FROM role_mounts ORDER BY role_id ASC, ordinal ASC')
        .all() as Record<string, unknown>[]
      return rows.map(mapMountRow)
    })
  }

  findRoleIdByCanonicalKey(canonicalKey: string): Promise<string | undefined> {
    return this.enqueue(() => {
      const row = this.db
        .prepare('SELECT role_id FROM role_mounts WHERE canonical_key = ?')
        .get(canonicalKey) as { role_id: string } | undefined
      return row?.role_id
    })
  }

  // ---------- bindings ----------

  bindSession(binding: Omit<SessionBindingRow, 'boundAt'> & { boundAt?: number }): Promise<void> {
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_bindings
             (session_id, role_id, workspace_path_snapshot, archived_at, visibility, source, bound_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          binding.sessionId,
          binding.roleId,
          binding.workspacePathSnapshot,
          binding.archivedAt,
          binding.visibility,
          binding.source,
          binding.boundAt ?? Date.now(),
        )
    })
  }

  /** 仅供事务回调内同步调用(迁移):单条绑定写入,不 enqueue。 */
  bindSessionInTransaction(binding: Omit<SessionBindingRow, 'boundAt'> & { boundAt?: number }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_bindings
           (session_id, role_id, workspace_path_snapshot, archived_at, visibility, source, bound_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.sessionId,
        binding.roleId,
        binding.workspacePathSnapshot,
        binding.archivedAt,
        binding.visibility,
        binding.source,
        binding.boundAt ?? Date.now(),
      )
  }

  getBinding(sessionId: string): Promise<SessionBindingRow | undefined> {
    return this.enqueue(() => {
      const row = this.db
        .prepare('SELECT * FROM session_bindings WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined
      return row ? mapBindingRow(row) : undefined
    })
  }

  listBindingRows(): Promise<SessionBindingRow[]> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare('SELECT * FROM session_bindings ORDER BY bound_at ASC')
        .all() as Record<string, unknown>[]
      return rows.map(mapBindingRow)
    })
  }

  setSessionArchived(sessionId: string, archivedAt: number | null): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('UPDATE session_bindings SET archived_at = ? WHERE session_id = ?').run(
        archivedAt,
        sessionId,
      )
    })
  }

  deleteBinding(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('DELETE FROM session_bindings WHERE session_id = ?').run(sessionId)
    })
  }

  /** 用户可见会话数聚合(visibility='user'):总数与未归档数。 */
  listSessionCounts(): Promise<Map<string, RoleSessionCounts>> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare(
          `SELECT role_id,
                  COUNT(*) AS total,
                  SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active
           FROM session_bindings WHERE visibility = 'user' GROUP BY role_id`,
        )
        .all() as Array<{ role_id: string; total: number | bigint; active: number | bigint }>
      const map = new Map<string, RoleSessionCounts>()
      for (const r of rows) {
        map.set(r.role_id, { sessionCount: Number(r.total), activeSessionCount: Number(r.active) })
      }
      return map
    })
  }

  // ---------- deletion jobs ----------

  upsertDeletionJob(
    job: Omit<DeletionJobRow, 'updatedAt' | 'lastError'> & {
      lastError?: string | null
      updatedAt?: number
    },
  ): Promise<void> {
    return this.enqueue(() => {
      this.db
        .prepare(
          `INSERT INTO role_deletion_jobs (role_id, impact_version, pending_session_ids, phase, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(role_id) DO UPDATE SET
             impact_version = excluded.impact_version,
             pending_session_ids = excluded.pending_session_ids,
             phase = excluded.phase,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .run(
          job.roleId,
          job.impactVersion,
          JSON.stringify(job.pendingSessionIds),
          job.phase,
          job.lastError ?? null,
          job.updatedAt ?? Date.now(),
        )
    })
  }

  getDeletionJob(roleId: string): Promise<DeletionJobRow | undefined> {
    return this.enqueue(() => {
      const row = this.db
        .prepare('SELECT * FROM role_deletion_jobs WHERE role_id = ?')
        .get(roleId) as Record<string, unknown> | undefined
      if (!row) return undefined
      return {
        roleId: row.role_id as string,
        impactVersion: row.impact_version as string,
        pendingSessionIds: JSON.parse(row.pending_session_ids as string) as string[],
        phase: row.phase as string,
        lastError: (row.last_error as string | null) ?? null,
        updatedAt: row.updated_at as number,
      }
    })
  }

  deleteDeletionJob(roleId: string): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('DELETE FROM role_deletion_jobs WHERE role_id = ?').run(roleId)
    })
  }

  listDeletionJobs(): Promise<DeletionJobRow[]> {
    return this.enqueue(() => {
      const rows = this.db.prepare('SELECT * FROM role_deletion_jobs').all() as Record<string, unknown>[]
      return rows.map((row) => ({
        roleId: row.role_id as string,
        impactVersion: row.impact_version as string,
        pendingSessionIds: JSON.parse(row.pending_session_ids as string) as string[],
        phase: row.phase as string,
        lastError: (row.last_error as string | null) ?? null,
        updatedAt: row.updated_at as number,
      }))
    })
  }

  // ---------- meta ----------

  getMeta(key: string): Promise<string | undefined> {
    return this.enqueue(() => {
      const row = this.db.prepare('SELECT value FROM registry_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value
    })
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.enqueue(() => {
      this.db
        .prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
    })
  }

  /** 等队列排空再关(usage-store 同款);退出竞争窗口不再打断 pending 删除收尾。 */
  async drainAndClose(): Promise<void> {
    this.closed = true
    await this.chain.catch(() => {})
    this.db.close()
  }
}

// ---------- 行映射(node:sqlite 返回 snake_case 列)----------

function mapRoleRow(r: Record<string, unknown>): RoleRow {
  return {
    id: r.id as string,
    kind: r.kind as RoleRow['kind'],
    displayName: r.display_name as string,
    templateId: r.template_id as string,
    homeRelPath: r.home_rel_path as string,
    guardrailsRelPath: r.guardrails_rel_path as string,
    guardrailsVersion: r.guardrails_version as number,
    lifecycle: r.lifecycle as RoleRow['lifecycle'],
    archivedAt: (r.archived_at as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }
}

function mapMountRow(r: Record<string, unknown>): RoleMountRow {
  return {
    roleId: r.role_id as string,
    workspacePath: r.workspace_path as string,
    canonicalKey: r.canonical_key as string,
    ordinal: r.ordinal as number,
    isPrimary: r.is_primary === 1,
    availability: r.availability as RoleMountRow['availability'],
  }
}

function mapBindingRow(r: Record<string, unknown>): SessionBindingRow {
  return {
    sessionId: r.session_id as string,
    roleId: r.role_id as string,
    workspacePathSnapshot: r.workspace_path_snapshot as string,
    archivedAt: (r.archived_at as number | null) ?? null,
    visibility: r.visibility as SessionBindingRow['visibility'],
    source: r.source as SessionBindingRow['source'],
    boundAt: r.bound_at as number,
  }
}
