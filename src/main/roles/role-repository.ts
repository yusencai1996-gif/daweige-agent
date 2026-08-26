import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AgentRunId,
  AgentRunStatus,
  AgentRunWaitingReason,
  DelegationEnvelope,
  DelegationResult,
} from '../../shared/domain/manager'

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

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id                    TEXT PRIMARY KEY,
  manager_session_id        TEXT NOT NULL,
  target_role_id            TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  target_role_name_snapshot TEXT NOT NULL,
  internal_session_id       TEXT UNIQUE,
  parent_run_id             TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  status                    TEXT NOT NULL CHECK (status IN (
    'awaiting-approval','queued','running','waiting',
    'completed','failed','rejected','interrupted'
  )),
  waiting_reason            TEXT CHECK (
    waiting_reason IS NULL OR waiting_reason IN ('manager-wait','user-approval')
  ),
  serial_slot               INTEGER UNIQUE CHECK (serial_slot IS NULL OR serial_slot = 1),
  user_request              TEXT NOT NULL,
  manager_conclusions_json  TEXT NOT NULL,
  task_brief                TEXT NOT NULL,
  acceptance_criteria_json  TEXT NOT NULL,
  allowed_paths_json        TEXT NOT NULL,
  result_json               TEXT,
  boundary_violations_json  TEXT NOT NULL DEFAULT '[]',
  failure_message           TEXT,
  wait_started_at           INTEGER,
  created_at                INTEGER NOT NULL,
  started_at                INTEGER,
  completed_at              INTEGER,
  updated_at                INTEGER NOT NULL,
  CHECK (
    (status IN ('awaiting-approval','queued','running','waiting') AND serial_slot = 1)
    OR
    (status IN ('completed','failed','rejected','interrupted') AND serial_slot IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_runs_manager_created
  ON agent_runs(manager_session_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_target
  ON agent_runs(target_role_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_internal
  ON agent_runs(internal_session_id);
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

export interface AgentRunRow {
  readonly runId: AgentRunId
  readonly managerSessionId: string
  readonly targetRoleId: string
  readonly targetRoleNameSnapshot: string
  readonly internalSessionId: string | null
  readonly parentRunId: AgentRunId | null
  readonly status: AgentRunStatus
  readonly waitingReason: AgentRunWaitingReason
  readonly envelope: DelegationEnvelope
  readonly result: DelegationResult | null
  /** 运行期主进程权威记录;toolName 是 DB 审计扩展,不改冻结 DTO。 */
  readonly boundaryViolations: readonly AgentRunBoundaryViolation[]
  readonly failureMessage: string | null
  readonly waitStartedAt: number | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly completedAt: number | null
  readonly updatedAt: number
}

export interface AgentRunBoundaryViolation {
  readonly path: string
  readonly toolName?: string
  readonly operation: 'read' | 'write'
  readonly reason: string
  readonly occurredAt: number
}

export interface CreateAgentRunInput {
  readonly runId: AgentRunId
  readonly managerSessionId: string
  readonly targetRoleId: string
  readonly targetRoleNameSnapshot: string
  readonly parentRunId?: AgentRunId | null
  readonly envelope: DelegationEnvelope
  readonly createdAt?: number
}

export type AgentRunTransition =
  | { readonly status: 'queued'; readonly at?: number }
  | { readonly status: 'running'; readonly internalSessionId?: string; readonly at?: number }
  | { readonly status: 'waiting'; readonly waitingReason: Exclude<AgentRunWaitingReason, null>; readonly at?: number }
  | { readonly status: 'completed'; readonly result: DelegationResult; readonly at?: number }
  | { readonly status: 'failed'; readonly failureMessage: string; readonly at?: number }
  | { readonly status: 'rejected'; readonly failureMessage?: string; readonly at?: number }
  | { readonly status: 'interrupted'; readonly failureMessage: string; readonly at?: number }

export class AgentRunTransitionError extends Error {
  constructor(runId: string, from: AgentRunStatus, to: AgentRunStatus, reason?: string) {
    super(`派活 ${runId} 不能从 ${from} 转为 ${to}${reason ? `:${reason}` : ''}`)
    this.name = 'AgentRunTransitionError'
  }
}

export class AgentRunSlotOccupiedError extends Error {
  readonly occupiedRunId: string

  constructor(occupiedRunId: string) {
    super(`已有派活正在进行:${occupiedRunId}`)
    this.name = 'AgentRunSlotOccupiedError'
    this.occupiedRunId = occupiedRunId
  }
}

export class RoleAgentRunBusyError extends Error {
  constructor() {
    super('这个角色还有派活正在进行，先等派活结束再归档或删除')
    this.name = 'RoleAgentRunBusyError'
  }
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
    // schema 版本也走同一连接的 Promise 队列;后续任何读写都会排在它之后。
    this.chain = this.chain.then(() => {
      this.db
        .prepare(
          `INSERT INTO registry_meta (key, value) VALUES ('manager_schema_version', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run()
    })
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
   * 守则保存的完整原子块(复审 B-01):文件替换与条件递增在同一队列槽内串行执行;
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

  /** 删除启动的事务原子块(复审 B-03):lifecycle=deleting 与 job 初始记录同事务。 */
  beginDeletionTransaction(
    roleId: string,
    impactVersion: string,
    pendingSessionIds: readonly string[],
  ): Promise<void> {
    return this.transaction(() => {
      const active = this.db
        .prepare(
          `SELECT 1 AS found FROM agent_runs
           WHERE target_role_id = ?
             AND status IN ('awaiting-approval','queued','running','waiting')
           LIMIT 1`,
        )
        .get(roleId) as { found: number } | undefined
      if (active) throw new RoleAgentRunBusyError()
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

  /** 归档的检查与落状态同事务；先封住新 spawn，再由服务层清理历史 internal 会话。 */
  archiveRoleIfIdle(roleId: string, archivedAt: number, updatedAt: number): Promise<void> {
    return this.transaction(() => {
      const active = this.db
        .prepare(
          `SELECT 1 AS found FROM agent_runs
           WHERE target_role_id = ?
             AND status IN ('awaiting-approval','queued','running','waiting')
           LIMIT 1`,
        )
        .get(roleId) as { found: number } | undefined
      if (active) throw new RoleAgentRunBusyError()
      this.db.prepare('UPDATE roles SET archived_at = ?, updated_at = ? WHERE id = ?').run(
        archivedAt,
        updatedAt,
        roleId,
      )
    })
  }

  // ---------- agent runs ----------

  /** spawn 的 DB 防线:BEGIN IMMEDIATE 内联查目标角色、全局串行槽,再插 awaiting run。 */
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRow> {
    assertStoredEnvelopeValid(input.envelope)
    return this.transaction(() => {
      const target = this.db
        .prepare(
          `SELECT id FROM roles
           WHERE id = ? AND kind = 'worker' AND lifecycle = 'ready' AND archived_at IS NULL`,
        )
        .get(input.targetRoleId) as { id: string } | undefined
      if (!target) {
        throw new Error('目标角色刚被删除或归档，本次未派出，请重新选择可用角色')
      }
      const occupied = this.db
        .prepare('SELECT run_id FROM agent_runs WHERE serial_slot = 1 LIMIT 1')
        .get() as { run_id: string } | undefined
      if (occupied) throw new AgentRunSlotOccupiedError(occupied.run_id)
      const at = input.createdAt ?? Date.now()
      this.db
        .prepare(
          `INSERT INTO agent_runs (
             run_id, manager_session_id, target_role_id, target_role_name_snapshot,
             internal_session_id, parent_run_id, status, waiting_reason, serial_slot,
             user_request, manager_conclusions_json, task_brief,
             acceptance_criteria_json, allowed_paths_json, result_json,
             boundary_violations_json, failure_message, wait_started_at,
             created_at, started_at, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'awaiting-approval', NULL, 1,
             ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, NULL, NULL, ?)` ,
        )
        .run(
          input.runId,
          input.managerSessionId,
          input.targetRoleId,
          input.targetRoleNameSnapshot,
          input.parentRunId ?? null,
          input.envelope.userRequest,
          JSON.stringify(input.envelope.managerConclusions),
          input.envelope.taskBrief,
          JSON.stringify(input.envelope.acceptanceCriteria),
          JSON.stringify(input.envelope.allowedWorkspacePaths),
          at,
          at,
        )
      return this.readAgentRunInTransaction(input.runId)!
    })
  }

  transitionAgentRun(runId: AgentRunId, transition: AgentRunTransition): Promise<AgentRunRow> {
    return this.transaction(() => {
      const current = this.readAgentRunInTransaction(runId)
      if (!current) throw new Error(`派活不存在:${runId}`)
      assertLegalTransition(current, transition)
      const at = transition.at ?? Date.now()
      const terminal = isTerminalStatus(transition.status)
      const internalSessionId =
        transition.status === 'running' && transition.internalSessionId !== undefined
          ? transition.internalSessionId
          : current.internalSessionId
      const waitingReason = transition.status === 'waiting' ? transition.waitingReason : null
      const waitStartedAt = transition.status === 'waiting' ? at : null
      const startedAt = transition.status === 'running' ? (current.startedAt ?? at) : current.startedAt
      const completedAt = terminal ? at : null
      const result =
        transition.status === 'completed'
          ? {
              ...transition.result,
              // DB 运行期记录永远是权威源;即使调用方漏合并也不丢失。
              boundaryViolations: mergeBoundaryViolations(
                current.boundaryViolations,
                transition.result.boundaryViolations,
              ),
            }
          : current.result
      const failureMessage =
        transition.status === 'failed' || transition.status === 'interrupted'
          ? transition.failureMessage
          : transition.status === 'rejected'
            ? (transition.failureMessage ?? null)
            : null
      this.db
        .prepare(
          `UPDATE agent_runs SET status = ?, waiting_reason = ?, serial_slot = ?,
             internal_session_id = ?, result_json = ?, boundary_violations_json = ?,
             failure_message = ?, wait_started_at = ?, started_at = ?, completed_at = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(
          transition.status,
          waitingReason,
          terminal ? null : 1,
          internalSessionId,
          result ? JSON.stringify(result) : null,
          JSON.stringify(
            transition.status === 'completed'
              ? (result?.boundaryViolations ?? current.boundaryViolations)
              : current.boundaryViolations,
          ),
          failureMessage,
          waitStartedAt,
          startedAt,
          completedAt,
          at,
          runId,
        )
      return this.readAgentRunInTransaction(runId)!
    })
  }

  getAgentRun(runId: AgentRunId): Promise<AgentRunRow | undefined> {
    return this.enqueue(() => this.readAgentRunInTransaction(runId))
  }

  getAgentRunByInternalSession(sessionId: string): Promise<AgentRunRow | undefined> {
    return this.enqueue(() => {
      const row = this.db
        .prepare('SELECT * FROM agent_runs WHERE internal_session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined
      return row ? this.mapAgentRunFailClosed(row) : undefined
    })
  }

  /** child gate 越界时立即追加,不等模型最终结果。 */
  appendAgentRunBoundaryViolation(
    runId: AgentRunId,
    violation: AgentRunBoundaryViolation,
  ): Promise<void> {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT boundary_violations_json FROM agent_runs WHERE run_id = ?')
        .get(runId) as { boundary_violations_json: string } | undefined
      if (!row) throw new Error(`派活不存在:${runId}`)
      const current = parseBoundaryViolations(
        row.boundary_violations_json,
        'boundary_violations_json',
      ) as AgentRunBoundaryViolation[]
      this.db
        .prepare(
          'UPDATE agent_runs SET boundary_violations_json = ?, updated_at = ? WHERE run_id = ?',
        )
        .run(JSON.stringify([...current, violation]), Date.now(), runId)
    })
  }

  listAgentRuns(managerSessionId?: string): Promise<AgentRunRow[]> {
    return this.enqueue(() => {
      const rows = (managerSessionId
        ? this.db
            .prepare('SELECT * FROM agent_runs WHERE manager_session_id = ? ORDER BY created_at ASC, run_id ASC')
            .all(managerSessionId)
        : this.db.prepare('SELECT * FROM agent_runs ORDER BY created_at ASC, run_id ASC').all()) as Record<string, unknown>[]
      return rows.map((row) => this.mapAgentRunFailClosed(row))
    })
  }

  hasActiveAgentRuns(filter: { readonly managerSessionId?: string; readonly targetRoleId?: string }): Promise<boolean> {
    return this.enqueue(() => {
      const clauses = ["status IN ('awaiting-approval','queued','running','waiting')"]
      const params: string[] = []
      if (filter.managerSessionId) {
        clauses.push('manager_session_id = ?')
        params.push(filter.managerSessionId)
      }
      if (filter.targetRoleId) {
        clauses.push('target_role_id = ?')
        params.push(filter.targetRoleId)
      }
      const row = this.db
        .prepare(`SELECT 1 AS found FROM agent_runs WHERE ${clauses.join(' AND ')} LIMIT 1`)
        .get(...params) as { found: number } | undefined
      return row !== undefined
    })
  }

  listAgentRunsByTargetRole(roleId: string): Promise<AgentRunRow[]> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare('SELECT * FROM agent_runs WHERE target_role_id = ? ORDER BY created_at ASC, run_id ASC')
        .all(roleId) as Record<string, unknown>[]
      return rows.map((row) => this.mapAgentRunFailClosed(row))
    })
  }

  deleteAgentRunsByTargetRole(roleId: string): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('DELETE FROM agent_runs WHERE target_role_id = ?').run(roleId)
    })
  }

  deleteAgentRunsByManagerSession(managerSessionId: string): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('DELETE FROM agent_runs WHERE manager_session_id = ?').run(managerSessionId)
    })
  }

  /** 启动恢复:四个非终态在一个 BEGIN IMMEDIATE 事务里全部收成 interrupted。 */
  recoverInterruptedAgentRuns(at = Date.now(), preserveAwaitingApproval = false): Promise<AgentRunRow[]> {
    return this.transaction(() => {
      const activeClause = preserveAwaitingApproval
        ? "status IN ('queued','running','waiting')"
        : "status IN ('awaiting-approval','queued','running','waiting')"
      const rows = this.db
        .prepare(
          `SELECT run_id FROM agent_runs
           WHERE ${activeClause}
           ORDER BY created_at ASC, run_id ASC`,
        )
        .all() as Array<{ run_id: string }>
      if (rows.length === 0) return []
      this.db
        .prepare(
          `UPDATE agent_runs SET status = 'interrupted', waiting_reason = NULL,
             serial_slot = NULL, failure_message = ?, wait_started_at = NULL,
             completed_at = ?, updated_at = ?
           WHERE ${activeClause}`,
        )
        .run('应用上次在派活中途退出，本次没有自动继续', at, at)
      return rows.map((row) => this.readAgentRunInTransaction(row.run_id)!)
    })
  }

  private readAgentRunInTransaction(runId: string): AgentRunRow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapAgentRunFailClosed(row) : undefined
  }

  /** JSON 脏数据绝不返回给模型;原地收成 failed 并释放串行槽。 */
  private mapAgentRunFailClosed(row: Record<string, unknown>): AgentRunRow {
    try {
      return mapAgentRunRow(row)
    } catch {
      const runId = row.run_id as string
      const at = Date.now()
      const ownsTransaction = !this.inTransaction
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .prepare(
            `UPDATE agent_runs SET status = 'failed', waiting_reason = NULL, serial_slot = NULL,
               manager_conclusions_json = '[]', acceptance_criteria_json = '[]',
               allowed_paths_json = '[]', result_json = NULL, boundary_violations_json = '[]',
               failure_message = '派活记录数据损坏，已安全停止', wait_started_at = NULL,
               completed_at = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(at, at, runId)
        if (ownsTransaction) this.db.exec('COMMIT')
      } catch (err) {
        if (ownsTransaction) {
          try {
            this.db.exec('ROLLBACK')
          } catch {
            // 保留原始修复错误
          }
        }
        throw err
      }
      const repaired = this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as Record<string, unknown>
      return mapAgentRunRow(repaired, true)
    }
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

const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'rejected',
  'interrupted',
])

const LEGAL_AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  'awaiting-approval': ['queued', 'rejected', 'interrupted'],
  queued: ['running', 'failed', 'interrupted'],
  running: ['waiting', 'completed', 'failed', 'interrupted'],
  waiting: ['running', 'waiting', 'completed', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  rejected: [],
  interrupted: [],
}

function isTerminalStatus(status: AgentRunStatus): boolean {
  return TERMINAL_AGENT_RUN_STATUSES.has(status)
}

function assertLegalTransition(current: AgentRunRow, transition: AgentRunTransition): void {
  if (!LEGAL_AGENT_RUN_TRANSITIONS[current.status].includes(transition.status)) {
    throw new AgentRunTransitionError(current.runId, current.status, transition.status)
  }
  if (
    transition.status === 'running' &&
    !(transition.internalSessionId ?? current.internalSessionId)
  ) {
    throw new AgentRunTransitionError(
      current.runId,
      current.status,
      transition.status,
      '尚未绑定 internal 会话',
    )
  }
}

function mapAgentRunRow(r: Record<string, unknown>, repaired = false): AgentRunRow {
  const managerConclusions = parseStringArray(r.manager_conclusions_json, 'manager_conclusions_json')
  const acceptanceCriteria = parseStringArray(r.acceptance_criteria_json, 'acceptance_criteria_json')
  const allowedWorkspacePaths = parseStringArray(r.allowed_paths_json, 'allowed_paths_json')
  const boundaryViolations = repaired
    ? []
    : parseBoundaryViolations(r.boundary_violations_json, 'boundary_violations_json')
  const result =
    repaired || r.result_json == null
      ? null
      : parseDelegationResult(r.result_json, boundaryViolations)
  const userRequest = requireString(r.user_request, 'user_request')
  const taskBrief = requireString(r.task_brief, 'task_brief')
  if (!repaired) {
    assertStoredEnvelopeValid({
      userRequest,
      managerConclusions,
      taskBrief,
      acceptanceCriteria,
      allowedWorkspacePaths,
    })
  }
  return {
    runId: requireString(r.run_id, 'run_id'),
    managerSessionId: requireString(r.manager_session_id, 'manager_session_id'),
    targetRoleId: requireString(r.target_role_id, 'target_role_id'),
    targetRoleNameSnapshot: requireString(
      r.target_role_name_snapshot,
      'target_role_name_snapshot',
    ),
    internalSessionId: optionalString(r.internal_session_id, 'internal_session_id'),
    parentRunId: optionalString(r.parent_run_id, 'parent_run_id'),
    status: requireAgentRunStatus(r.status),
    waitingReason: requireWaitingReason(r.waiting_reason),
    envelope: {
      userRequest,
      managerConclusions,
      taskBrief,
      acceptanceCriteria,
      allowedWorkspacePaths,
    },
    result,
    boundaryViolations,
    failureMessage: optionalString(r.failure_message, 'failure_message'),
    waitStartedAt: optionalNumber(r.wait_started_at, 'wait_started_at'),
    createdAt: requireNumber(r.created_at, 'created_at'),
    startedAt: optionalNumber(r.started_at, 'started_at'),
    completedAt: optionalNumber(r.completed_at, 'completed_at'),
    updatedAt: requireNumber(r.updated_at, 'updated_at'),
  }
}

function assertStoredEnvelopeValid(envelope: DelegationEnvelope): void {
  if (!hasCharLength(envelope.userRequest, 1, 100_000)) throw new Error('user_request 长度非法')
  if (!hasCharLength(envelope.taskBrief, 1, 4_000)) throw new Error('task_brief 长度非法')
  if (
    envelope.managerConclusions.length > 20 ||
    envelope.managerConclusions.some((item) => !hasCharLength(item, 1, 2_000))
  ) {
    throw new Error('manager_conclusions_json 内容非法')
  }
  if (
    envelope.acceptanceCriteria.length < 1 ||
    envelope.acceptanceCriteria.length > 20 ||
    envelope.acceptanceCriteria.some((item) => !hasCharLength(item, 1, 1_000))
  ) {
    throw new Error('acceptance_criteria_json 内容非法')
  }
  if (
    envelope.allowedWorkspacePaths.length < 1 ||
    envelope.allowedWorkspacePaths.length > 8 ||
    envelope.allowedWorkspacePaths.some((item) => !/^[A-Za-z]:[\\/]/.test(item))
  ) {
    throw new Error('allowed_paths_json 内容非法')
  }
}

function hasCharLength(value: string, min: number, max: number): boolean {
  const length = [...value].length
  return length >= min && length <= max
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') throw new Error(`${field} 不是 JSON 字符串`)
  return JSON.parse(value) as unknown
}

function parseStringArray(value: unknown, field: string): string[] {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 不是字符串数组`)
  }
  return parsed
}

function parseBoundaryViolations(
  value: unknown,
  field: string,
): DelegationResult['boundaryViolations'] {
  const parsed = parseJson(value, field)
  if (!Array.isArray(parsed) || parsed.some((item) => !isBoundaryViolation(item))) {
    throw new Error(`${field} 形态损坏`)
  }
  return parsed as DelegationResult['boundaryViolations']
}

function isBoundaryViolation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.path === 'string' &&
    (item.operation === 'read' || item.operation === 'write') &&
    typeof item.reason === 'string' &&
    typeof item.occurredAt === 'number'
  )
}

function mergeBoundaryViolations(
  authoritative: readonly AgentRunBoundaryViolation[],
  additions: DelegationResult['boundaryViolations'],
): AgentRunBoundaryViolation[] {
  const out = [...authoritative]
  const seen = new Set(
    out.map((item) =>
      JSON.stringify([item.path, item.operation, item.reason, item.occurredAt]),
    ),
  )
  for (const item of additions) {
    const key = JSON.stringify([item.path, item.operation, item.reason, item.occurredAt])
    if (!seen.has(key)) {
      out.push(item)
      seen.add(key)
    }
  }
  return out
}

function parseDelegationResult(
  value: unknown,
  boundaryViolations: DelegationResult['boundaryViolations'],
): DelegationResult {
  const parsed = parseJson(value, 'result_json')
  if (!parsed || typeof parsed !== 'object') throw new Error('result_json 形态损坏')
  const result = parsed as Record<string, unknown>
  return {
    summary: requireString(result.summary, 'result.summary'),
    conclusions: requireStringArray(result.conclusions, 'result.conclusions'),
    artifactPaths: requireStringArray(result.artifactPaths, 'result.artifactPaths'),
    unmetCriteria: requireStringArray(result.unmetCriteria, 'result.unmetCriteria'),
    // DB 独立列是越界事实的权威源,忽略 result_json 中模型可控的同名字段。
    boundaryViolations,
  }
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 不是字符串数组`)
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 不是字符串`)
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null) return null
  return requireString(value, field)
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`${field} 不是数字`)
  return value
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value == null) return null
  return requireNumber(value, field)
}

function requireAgentRunStatus(value: unknown): AgentRunStatus {
  if (
    value === 'awaiting-approval' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'rejected' ||
    value === 'interrupted'
  ) {
    return value
  }
  throw new Error('status 非法')
}

function requireWaitingReason(value: unknown): AgentRunWaitingReason {
  if (value == null) return null
  if (value === 'manager-wait' || value === 'user-approval') return value
  throw new Error('waiting_reason 非法')
}
