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
  graph_id                  TEXT NOT NULL,
  queue_reason              TEXT CHECK (
    queue_reason IS NULL OR queue_reason IN ('dependency','workspace-lock','concurrency-limit')
  ),
  followup_count            INTEGER NOT NULL DEFAULT 0 CHECK (followup_count >= 0),
  interrupt_source          TEXT CHECK (
    interrupt_source IS NULL OR interrupt_source IN ('user','manager','app-restart')
  ),
  interrupted_at            INTEGER,
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
  CHECK (status = 'queued' OR queue_reason IS NULL),
  CHECK (status = 'interrupted' OR interrupt_source IS NULL),
  CHECK (status = 'interrupted' OR interrupted_at IS NULL)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_runs_manager_created
  ON agent_runs(manager_session_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_target
  ON agent_runs(target_role_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_internal
  ON agent_runs(internal_session_id);

CREATE TABLE IF NOT EXISTS agent_run_edges (
  run_id            TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  depends_on_run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('dependency','handoff')),
  ordinal           INTEGER NOT NULL,
  PRIMARY KEY (run_id, depends_on_run_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_run_edges_dep
  ON agent_run_edges(depends_on_run_id);

CREATE TABLE IF NOT EXISTS agent_run_inputs (
  input_id       TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('initial','handoff','followup')),
  source_run_id  TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  payload_json   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  delivered_at   INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_run
  ON agent_run_inputs(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_run_workspace_leases (
  run_id          TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  canonical_root  TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  PRIMARY KEY (run_id, canonical_root)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_run_leases_root
  ON agent_run_workspace_leases(canonical_root);
`

/**
 * v2 收尾 DDL:graph 索引引用 graph_id 列,v1 旧表没有该列——
 * 只能在确认表已是 v2 形态(新库直建/迁移完成)后执行。
 */
const SCHEMA_V2_FINALIZE = `
CREATE INDEX IF NOT EXISTS idx_agent_runs_graph
  ON agent_runs(graph_id, created_at, run_id);
`

/** v1→v2 重建时的目标表 DDL(与 SCHEMA 中 v2 形态一致)。 */
const AGENT_RUNS_V2_DDL = `
CREATE TABLE agent_runs (
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
  graph_id                  TEXT NOT NULL,
  queue_reason              TEXT CHECK (
    queue_reason IS NULL OR queue_reason IN ('dependency','workspace-lock','concurrency-limit')
  ),
  followup_count            INTEGER NOT NULL DEFAULT 0 CHECK (followup_count >= 0),
  interrupt_source          TEXT CHECK (
    interrupt_source IS NULL OR interrupt_source IN ('user','manager','app-restart')
  ),
  interrupted_at            INTEGER,
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
  CHECK (status = 'queued' OR queue_reason IS NULL),
  CHECK (status = 'interrupted' OR interrupt_source IS NULL),
  CHECK (status = 'interrupted' OR interrupted_at IS NULL)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_agent_runs_manager_created
  ON agent_runs(manager_session_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_target
  ON agent_runs(target_role_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_internal
  ON agent_runs(internal_session_id);
`

import { randomBytes, createHash } from 'node:crypto'

/** 协作链 ID:graph- + 16 位小写十六进制(主进程生成;shared 契约 runtime 校验同格式)。 */
export function newGraphId(): string {
  return `graph-${randomBytes(8).toString('hex')}`
}

/**
 * 迁移坏 runId 的确定性替身(复审整改):非法 ID 不许进 v2
 * (IPC schema 会拒操作),sha256 前 16 位保证同输入同输出,留档可追溯。
 */
export function legacySafeRunId(raw: string): string {
  if (/^run-[a-f0-9]{16}$/.test(raw)) return raw
  return `run-${createHash('sha256').update(`daweige-legacy:${raw}`).digest('hex').slice(0, 16)}`
}

const GRAPH_ID_PATTERN = /^graph-[a-f0-9]{16}$/

function isTerminalStatusLiteral(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' ||
    status === 'rejected' || status === 'interrupted'
  )
}

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
  /** 所属协作链(0.4.0 D):v1 迁移行每 run 独立成单节点 graph。 */
  readonly graphId: string
  /** 显式依赖(edges 表 kind=dependency;空=可独立调度)。 */
  readonly dependsOnRunIds: readonly AgentRunId[]
  /** 排队原因(仅 queued 态非空)。 */
  readonly queueReason: 'dependency' | 'workspace-lock' | 'concurrency-limit' | null
  readonly followupCount: number
  /** 打断来源(仅 interrupted 态非空)。 */
  readonly interruptSource: 'user' | 'manager' | 'app-restart' | null
  readonly interruptedAt: number | null
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
  /** 所属协作链;缺省时服务端生成单节点 graph(0.3 单发派活兼容路径)。 */
  readonly graphId?: string
  /** 显式依赖(必须同 graph;自环/跨 graph 由插入校验拒绝)。 */
  readonly dependsOnRunIds?: readonly AgentRunId[]
  readonly envelope: DelegationEnvelope
  readonly createdAt?: number
}

export type AgentRunTransition =
  | { readonly status: 'queued'; readonly queueReason?: 'dependency' | 'workspace-lock' | 'concurrency-limit'; readonly at?: number }
  | { readonly status: 'running'; readonly internalSessionId?: string; readonly at?: number }
  | { readonly status: 'waiting'; readonly waitingReason: Exclude<AgentRunWaitingReason, null>; readonly at?: number }
  | { readonly status: 'completed'; readonly result: DelegationResult; readonly at?: number }
  | { readonly status: 'failed'; readonly failureMessage: string; readonly at?: number }
  | { readonly status: 'rejected'; readonly failureMessage?: string; readonly at?: number }
  | { readonly status: 'interrupted'; readonly failureMessage: string; readonly interruptSource?: 'user' | 'manager' | 'app-restart'; readonly at?: number }

export class AgentRunTransitionError extends Error {
  constructor(runId: string, from: AgentRunStatus, to: AgentRunStatus, reason?: string) {
    super(`派活 ${runId} 不能从 ${from} 转为 ${to}${reason ? `:${reason}` : ''}`)
    this.name = 'AgentRunTransitionError'
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
    // schema 版本与 v1→v2 迁移也走同一连接的 Promise 队列;后续任何读写都会排在它之后。
    this.chain = this.chain.then(() => {
      try {
        this.migrateAgentRunsToV2IfNeeded()
      } catch (err) {
        // 迁移失败必须留痕:库保持 v1,下次启动重试;静默吞错会让读写全踩"列不存在"
        console.error(
          '[roles] agent_runs v2 迁移失败(库保持 v1,下次启动重试):',
          err instanceof Error ? err.message : String(err),
        )
        throw err
      }
      this.db
        .prepare(
          `INSERT INTO registry_meta (key, value) VALUES ('manager_schema_version', '2')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run()
    })
  }

  /**
   * roles.sqlite agent_runs v1→v2(0.4.0 D,PLAN §6.1):去掉 serial_slot(物理唯一),
   * 新增 graph_id/queue_reason/followup_count/interrupt_source/interrupted_at。
   * SQLite 不能 drop inline UNIQUE,必须在事务里重建表:
   * 行级校验(envelope/result JSON、runId)→ 坏行按既有 fail-closed 方式收 failed;
   * 行数对账后才切表;FK 迁移期间按 SQLite 官方建议关闭(PRAGMA 不能在事务内改,前后各一次)。
   * 幂等:表已是 v2(无 serial_slot 列)则跳过。
   */
  private migrateAgentRunsToV2IfNeeded(): void {
    const columns = this.db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{
      name: string
    }>
    const hasSerialSlot = columns.some((c) => c.name === 'serial_slot')
    if (!hasSerialSlot) {
      this.db.exec(SCHEMA_V2_FINALIZE)
      return
    }
    console.warn('[roles] 检测到 v1 agent_runs 表,开始 v2 重建迁移(去掉串行槽,加协作链列)')
    this.db.exec('PRAGMA foreign_keys = OFF;')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const at = Date.now()
      const existing = this.db.prepare('SELECT * FROM agent_runs').all() as Array<
        Record<string, unknown>
      >
      this.db.exec('DROP TABLE agent_runs')
      this.db.exec(AGENT_RUNS_V2_DDL)
      const insert = this.db.prepare(
        `INSERT INTO agent_runs (
           run_id, manager_session_id, target_role_id, target_role_name_snapshot,
           internal_session_id, parent_run_id, status, waiting_reason,
           graph_id, queue_reason, followup_count, interrupt_source, interrupted_at,
           user_request, manager_conclusions_json, task_brief,
           acceptance_criteria_json, allowed_paths_json, result_json,
           boundary_violations_json, failure_message, wait_started_at,
           created_at, started_at, completed_at, updated_at
         ) VALUES (
           ?, ?, ?, ?,               -- run_id, manager_session_id, target_role_id, target_role_name_snapshot
           ?, ?, ?, ?,               -- internal_session_id, parent_run_id, status, waiting_reason
           ?, NULL, 0, ?, ?,         -- graph_id, queue_reason(NULL), followup_count(0), interrupt_source, interrupted_at
           ?, ?, ?, ?, ?, ?,         -- user_request, manager_conclusions_json, task_brief, acceptance_criteria_json, allowed_paths_json, result_json
           ?, ?, ?,                  -- boundary_violations_json, failure_message, wait_started_at
           ?, ?, ?, ?                -- created_at, started_at, completed_at, updated_at
         )`,
      )
      for (const row of existing) {
        const legacyStatus = String(row.status)
        // 启动恢复遗留的非终态:v1 里它们曾占着串行槽;迁移时同样收成 interrupted(app-restart)
        const wasInterruptedByRecovery = legacyStatus === 'interrupted'
        const migratedStatus =
          legacyStatus === 'awaiting-approval' || legacyStatus === 'queued' ||
          legacyStatus === 'running' || legacyStatus === 'waiting'
            ? 'interrupted'
            : legacyStatus
        let mapped: ReturnType<RoleRepository['remapLegacyRunPayloads']>
        try {
          mapped = this.remapLegacyRunPayloads(row)
        } catch {
          // 坏行 fail-closed:收 failed,不注入模型(与 mapAgentRunFailClosed 同语义);
          // runId 非法时换确定性替身(sha256 前 16 位)——非法 ID 不许进 v2(复审整改)
          insert.run(
            legacySafeRunId(String(row.run_id ?? '')),
            String(row.manager_session_id ?? ''), String(row.target_role_id ?? ''),
            String(row.target_role_name_snapshot ?? ''), null, null, 'failed', null,
            newGraphId(), null, null,
            String(row.user_request ?? ''), '[]', String(row.task_brief ?? ''),
            '[]', '[]', null, '[]',
            '派活记录数据损坏(迁移时安全停止)', null,
            Number(row.created_at ?? at), null, at, at,
          )
          console.error(`[roles] v2 迁移:run ${String(row.run_id)} 数据损坏,已收 failed`)
          continue
        }
        insert.run(
          mapped.runId, mapped.managerSessionId, mapped.targetRoleId,
          mapped.targetRoleNameSnapshot, mapped.internalSessionId,
          mapped.parentRunId, migratedStatus, null,
          newGraphId(),
          wasInterruptedByRecovery || migratedStatus === 'interrupted' ? 'app-restart' : null,
          migratedStatus === 'interrupted' ? at : null,
          mapped.userRequest, mapped.managerConclusionsJson, mapped.taskBrief,
          mapped.acceptanceCriteriaJson, mapped.allowedPathsJson, mapped.resultJson,
          mapped.boundaryViolationsJson,
          migratedStatus === 'interrupted'
            ? String(row.failure_message ?? '应用上次在派活中途退出，本次没有自动继续')
            : (row.failure_message == null ? null : String(row.failure_message)),
          null,
          Number(row.created_at ?? at),
          row.started_at == null ? null : Number(row.started_at),
          migratedStatus === 'interrupted' || isTerminalStatusLiteral(migratedStatus)
            ? Number(row.completed_at ?? at)
            : null,
          at,
        )
      }
      const before = existing.length
      const after = (this.db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n
      if (before !== after) {
        throw new Error(`v2 迁移行数对账失败(前 ${before} 后 ${after}),已回滚,下次启动重试`)
      }
      // FK 对账(复审整改):PRAGMA foreign_key_check 对 WITHOUT ROWID 表返回 rowid=NULL
      // 无法定位行——改用 SELECT 主动找孤儿引用(v1 库 FK OFF 期间手工写入才可能产生)。
      // parent 孤儿可修(清引用);target_role 孤儿列 NOT NULL 无法根治,收 failed 保留(仅显示,不可再操作)。
      const orphanParents = this.db
        .prepare(
          `SELECT run_id FROM agent_runs
           WHERE parent_run_id IS NOT NULL
             AND parent_run_id NOT IN (SELECT run_id FROM agent_runs)`,
        )
        .all() as Array<{ run_id: string }>
      for (const row of orphanParents) {
        this.db
          .prepare(
            `UPDATE agent_runs SET parent_run_id = NULL, updated_at = ? WHERE run_id = ?`,
          )
          .run(at, row.run_id)
        console.error(`[roles] v2 迁移:run ${row.run_id} 的上游引用残缺,已摘除 parent`)
      }
      const orphanTargets = this.db
        .prepare(
          `SELECT run_id, target_role_id AS t, target_role_name_snapshot AS n FROM agent_runs
           WHERE target_role_id NOT IN (SELECT id FROM roles)`,
        )
        .all() as Array<{ run_id: string; t: string; n: string }>
      if (orphanTargets.length > 0) {
        // FK 要求 roles.id 存在且 target_role_id NOT NULL——补 legacy-unresolved 占位角色
        // (kind 不进正常角色流,归档态不可派活),既满足 FK 又保留留档(复审整改)
        const insertPlaceholder = this.db.prepare(
          `INSERT INTO roles (id, kind, display_name, template_id, home_rel_path,
             guardrails_rel_path, guardrails_version, lifecycle, archived_at, created_at, updated_at)
           VALUES (?, 'legacy-unresolved', ?, 'legacy-placeholder', ?, 'guardrails.md', 1, 'ready', ?, ?, ?)`,
        )
        const placeholderIds = new Set<string>()
        const markFailed = this.db.prepare(
          `UPDATE agent_runs SET status = 'failed',
             failure_message = '迁移发现目标角色引用残缺,已安全停止(该记录仅留档)', updated_at = ?
           WHERE run_id = ?`,
        )
        for (const row of orphanTargets) {
          if (!placeholderIds.has(row.t)) {
            placeholderIds.add(row.t)
            insertPlaceholder.run(
              row.t, row.n || '已删除的角色', `daweige/agents/legacy/${row.t}`, at, at, at,
            )
          }
          markFailed.run(at, row.run_id)
        }
        console.error(`[roles] v2 迁移:${orphanTargets.length} 条派活的目标角色已不存在,补占位角色并收 failed 留档`)
      }
      // FK 复查(复审整改):修复后仍有 violation = 漏网孤儿类型,整体回滚拒绝带病进 v2
      const fkViolations = this.db
        .prepare('PRAGMA foreign_key_check')
        .all() as Array<Record<string, unknown>>
      if (fkViolations.length > 0) {
        throw new Error(
          `v2 迁移外键对账失败(${fkViolations.length} 条 violation),已回滚;请检查数据库孤儿引用`,
        )
      }
      this.db.exec('COMMIT')
      this.db.exec(SCHEMA_V2_FINALIZE)
      console.warn(`[roles] v2 迁移完成:${before} 行(run 级独立 graph,非终态收 interrupted/app-restart)`)
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 连接已坏时 ROLLBACK 可能失败;保留原始错误
      }
      this.db.exec('PRAGMA foreign_keys = ON;')
      throw err
    }
    this.db.exec('PRAGMA foreign_keys = ON;')
  }

  /** v1 行的 JSON 载荷逐项校验(envelope 结构+result 形态+boundary 形态+runId 格式);任何坏载荷抛错由调用方收 failed。 */
  private remapLegacyRunPayloads(row: Record<string, unknown>): {
    runId: string
    managerSessionId: string
    targetRoleId: string
    targetRoleNameSnapshot: string
    internalSessionId: string | null
    parentRunId: string | null
    userRequest: string
    managerConclusionsJson: string
    taskBrief: string
    acceptanceCriteriaJson: string
    allowedPathsJson: string
    resultJson: string | null
    boundaryViolationsJson: string
  } {
    // runId 格式校验:非法格式进 v2 后无法通过 IPC schema 操作,必须在迁移事务内收口
    const runId = String(row.run_id ?? '')
    if (!/^run-[a-f0-9]{16}$/.test(runId)) throw new Error(`run_id 格式非法:${runId}`)
    const envelope = {
      userRequest: String(row.user_request ?? ''),
      managerConclusions: JSON.parse(String(row.manager_conclusions_json ?? '[]')) as string[],
      taskBrief: String(row.task_brief ?? ''),
      acceptanceCriteria: JSON.parse(String(row.acceptance_criteria_json ?? '[]')) as string[],
      allowedWorkspacePaths: JSON.parse(String(row.allowed_paths_json ?? '[]')) as string[],
    }
    assertStoredEnvelopeValid(envelope)
    // result 形态校验(语法合法但结构损坏的 result 不许带病进 v2)
    let resultObj: unknown = null
    if (row.result_json != null) {
      resultObj = JSON.parse(String(row.result_json))
    }
    if (resultObj !== null) {
      // 复用读路径的形态校验(boundaryViolations 传空——它单独校验)
      parseDelegationResult(JSON.stringify(resultObj), [])
    }
    // boundary 形态校验(原样 String 搬运会把坏形态带进 v2,首次读取才炸)
    const boundaryViolations = parseBoundaryViolations(
      String(row.boundary_violations_json ?? '[]'),
      'boundary_violations_json',
    )
    return {
      runId,
      managerSessionId: String(row.manager_session_id ?? ''),
      targetRoleId: String(row.target_role_id ?? ''),
      targetRoleNameSnapshot: String(row.target_role_name_snapshot ?? ''),
      internalSessionId: row.internal_session_id == null ? null : String(row.internal_session_id),
      parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
      userRequest: envelope.userRequest,
      managerConclusionsJson: JSON.stringify(envelope.managerConclusions),
      taskBrief: envelope.taskBrief,
      acceptanceCriteriaJson: JSON.stringify(envelope.acceptanceCriteria),
      allowedPathsJson: JSON.stringify(envelope.allowedWorkspacePaths),
      resultJson: resultObj === null ? null : JSON.stringify(resultObj),
      boundaryViolationsJson: JSON.stringify(boundaryViolations),
    }
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

  /**
   * spawn 的 DB 防线(0.4.0 D,PLAN §6.1/6.2):BEGIN IMMEDIATE 内联查目标角色、
   * 校验 graph 归属/依赖边/图规模,再插 awaiting run + initial input + dependency edges。
   * 并行上限(3)/依赖等待/根互斥由调度器+acquireLeasesAndStart 管辖,这里不设单活闸门。
   */
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRow> {
    assertStoredEnvelopeValid(input.envelope)
    const graphId = input.graphId ?? newGraphId()
    if (!GRAPH_ID_PATTERN.test(graphId)) {
      return Promise.reject(new Error('协作链编号格式不合法'))
    }
    const deps = input.dependsOnRunIds ?? []
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
      // graph 归属校验:同 graph 的已有 run 必须同 manager(防跨会话串图)
      if (input.graphId !== undefined) {
        const owner = this.db
          .prepare('SELECT manager_session_id AS m FROM agent_runs WHERE graph_id = ? LIMIT 1')
          .get(graphId) as { m: string } | undefined
        if (owner && owner.m !== input.managerSessionId) {
          throw new Error('协作链不属于当前总管会话，不能在链上派活')
        }
      }
      // 依赖边校验:必须同 graph 且不能自环(环检测由调度器插边前 DFS,这里挡住直接错)
      for (const dep of deps) {
        if (dep === input.runId) throw new Error('派活不能依赖自己')
        const depRow = this.db
          .prepare('SELECT graph_id AS g FROM agent_runs WHERE run_id = ?')
          .get(dep) as { g: string } | undefined
        if (!depRow) throw new Error(`依赖的派活不存在:${dep}`)
        if (depRow.g !== graphId) throw new Error('依赖的派活不在同一条协作链上')
      }
      // parent 校验:同 graph(跨链 parent 会破坏族谱归属)
      if (input.parentRunId != null) {
        const parentRow = this.db
          .prepare('SELECT graph_id AS g FROM agent_runs WHERE run_id = ?')
          .get(input.parentRunId) as { g: string } | undefined
        if (!parentRow) throw new Error(`上游派活不存在:${input.parentRunId}`)
        if (parentRow.g !== graphId) throw new Error('上游派活不在同一条协作链上')
      }
      // 依赖数量与图规模上限(PLAN §6.2:每节点 ≤8 依赖、每 graph ≤64 节点)
      if (deps.length > 8) throw new Error('一条派活最多依赖 8 个上游')
      const graphSize = this.db
        .prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE graph_id = ?')
        .get(graphId) as { c: number }
      if (graphSize.c >= 64) throw new Error('这条协作链已有 64 个节点,不能再加;请开新链')
      // DFS 防环(spawn 边是"新节点→已有节点",逻辑上不成环;纵深防御,不靠推理兜底)
      if (deps.length > 0 && this.graphWouldCycle(graphId, input.runId, deps)) {
        throw new Error('这条依赖会形成循环,已拒绝')
      }
      const at = input.createdAt ?? Date.now()
      this.db
        .prepare(
          `INSERT INTO agent_runs (
             run_id, manager_session_id, target_role_id, target_role_name_snapshot,
             internal_session_id, parent_run_id, status, waiting_reason,
             graph_id, queue_reason, followup_count, interrupt_source, interrupted_at,
             user_request, manager_conclusions_json, task_brief,
             acceptance_criteria_json, allowed_paths_json, result_json,
             boundary_violations_json, failure_message, wait_started_at,
             created_at, started_at, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'awaiting-approval', NULL, ?, NULL, 0, NULL, NULL,
             ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, NULL, NULL, ?)` ,
        )
        .run(
          input.runId,
          input.managerSessionId,
          input.targetRoleId,
          input.targetRoleNameSnapshot,
          input.parentRunId ?? null,
          graphId,
          input.envelope.userRequest,
          JSON.stringify(input.envelope.managerConclusions),
          input.envelope.taskBrief,
          JSON.stringify(input.envelope.acceptanceCriteria),
          JSON.stringify(input.envelope.allowedWorkspacePaths),
          at,
          at,
        )
      // initial input(delegation 信封全文,child 启动时投递;followup/handoff 后续追加)
      this.db
        .prepare(
          `INSERT INTO agent_run_inputs (input_id, run_id, kind, source_run_id, payload_json, created_at, delivered_at)
           VALUES (?, ?, 'initial', NULL, ?, ?, NULL)`,
        )
        .run(`in-${randomBytes(8).toString('hex')}`, input.runId, JSON.stringify(input.envelope), at)
      for (let i = 0; i < deps.length; i++) {
        const dep = deps[i]!
        this.db
          .prepare(
            `INSERT INTO agent_run_edges (run_id, depends_on_run_id, kind, ordinal)
             VALUES (?, ?, 'dependency', ?)`,
          )
          .run(input.runId, dep, i)
      }
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
      const queueReason =
        transition.status === 'queued'
          ? (transition.queueReason ?? null)
          : null
      const interruptSource =
        transition.status === 'interrupted'
          ? (transition.interruptSource ?? 'user')
          : null
      const interruptedAt = transition.status === 'interrupted' ? at : null
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
          `UPDATE agent_runs SET status = ?, waiting_reason = ?, queue_reason = ?,
             interrupt_source = ?, interrupted_at = ?,
             internal_session_id = ?, result_json = ?, boundary_violations_json = ?,
             failure_message = ?, wait_started_at = ?, started_at = ?, completed_at = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(
          transition.status,
          waitingReason,
          queueReason,
          interruptSource,
          interruptedAt,
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
      // PLAN §6.2:终态必须同事务释放租约(用户打断/完成/失败都不留持久 lease 残留窗口)
      if (terminal) {
        this.db.prepare('DELETE FROM agent_run_workspace_leases WHERE run_id = ?').run(runId)
      }
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
      return row
        ? this.mapAgentRunFailClosed(row, this.depsOf(String(row.run_id)))
        : undefined
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
      return this.mapRowsWithDeps(rows)
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
      return this.mapRowsWithDeps(rows)
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

  /** 启动恢复:四个非终态在一个 BEGIN IMMEDIATE 事务里全部收成 interrupted(app-restart)。 */
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
      // 恢复时孤儿租约一并清理(PLAN §6.2)——即使没有活跃 run 也要清(防上轮终态遗留)
      this.db
        .prepare(
          `DELETE FROM agent_run_workspace_leases
           WHERE run_id IN (SELECT run_id FROM agent_runs WHERE status IN ('completed','failed','rejected','interrupted'))`,
        )
        .run()
      if (rows.length === 0) return []
      this.db
        .prepare(
          `UPDATE agent_runs SET status = 'interrupted', waiting_reason = NULL,
             queue_reason = NULL, interrupt_source = 'app-restart', interrupted_at = ?,
             failure_message = ?, wait_started_at = NULL,
             completed_at = ?, updated_at = ?
           WHERE ${activeClause}`,
        )
        .run(at, '应用上次在派活中途退出，本次没有自动继续', at, at)
      return rows.map((row) => this.readAgentRunInTransaction(row.run_id)!)
    })
  }

  private readAgentRunInTransaction(runId: string): AgentRunRow | undefined {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return this.mapAgentRunFailClosed(row, this.depsOf(runId))
  }

  /** dependency 边按 ordinal 稳定排序(单 run 查询)。 */
  private depsOf(runId: string): AgentRunId[] {
    // dependency 与 handoff 边同向(target 依赖 source),调度等待/族谱都要看见:
    // send_message 交棒把 dependency 边覆盖为 handoff 后,依赖语义不能丢
    const rows = this.db
      .prepare(
        `SELECT depends_on_run_id AS d FROM agent_run_edges
         WHERE run_id = ? ORDER BY ordinal ASC`,
      )
      .all(runId) as Array<{ d: string }>
    return rows.map((r) => r.d)
  }

  /** 批量读(列表路径)后统一挂依赖边,避免 N+1 逐 run 查询。 */
  private mapRowsWithDeps(rows: readonly Record<string, unknown>[]): AgentRunRow[] {
    if (rows.length === 0) return []
    const placeholders = rows.map(() => '?').join(',')
    const edgeRows = this.db
      .prepare(
        `SELECT run_id AS r, depends_on_run_id AS d FROM agent_run_edges
         WHERE run_id IN (${placeholders}) ORDER BY ordinal ASC`,
      )
      .all(...rows.map((row) => String(row.run_id))) as Array<{ r: string; d: string }>
    const byRun = new Map<string, AgentRunId[]>()
    for (const e of edgeRows) {
      const list = byRun.get(e.r) ?? []
      list.push(e.d)
      byRun.set(e.r, list)
    }
    return rows.map((row) => this.mapAgentRunFailClosed(row, byRun.get(String(row.run_id)) ?? []))
  }

  /** JSON 脏数据绝不返回给模型;原地收成 failed(协作链列保留,graph 不变)。 */
  private mapAgentRunFailClosed(
    row: Record<string, unknown>,
    dependsOnRunIds: readonly AgentRunId[] = [],
  ): AgentRunRow {
    try {
      return mapAgentRunRow(row, false, dependsOnRunIds)
    } catch {
      const runId = row.run_id as string
      const at = Date.now()
      const ownsTransaction = !this.inTransaction
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .prepare(
            `UPDATE agent_runs SET status = 'failed', waiting_reason = NULL, queue_reason = NULL,
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
      return mapAgentRunRow(repaired, true, [])
    }
  }

  // ---------- 协作链 v2:edges / inputs / leases(PLAN §6.1) ----------

  /** 整图节点+边(调度/族谱视图数据源;归属校验由调用方做)。边两端都必须在本 graph 内(防跨图边破坏 DTO 自洽)。 */
  getAgentRunGraph(graphId: string): Promise<{ rows: AgentRunRow[]; edges: Array<{ from: string; to: string; kind: 'dependency' | 'handoff' }> }> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare('SELECT * FROM agent_runs WHERE graph_id = ? ORDER BY created_at ASC, run_id ASC')
        .all(graphId) as Record<string, unknown>[]
      const mapped = this.mapRowsWithDeps(rows)
      const edgeRows = this.db
        .prepare(
          `SELECT e.run_id AS r, e.depends_on_run_id AS d, e.kind AS k
           FROM agent_run_edges e
           WHERE e.run_id IN (SELECT run_id FROM agent_runs WHERE graph_id = ?)
             AND e.depends_on_run_id IN (SELECT run_id FROM agent_runs WHERE graph_id = ?)`,
        )
        .all(graphId, graphId) as Array<{ r: string; d: string; k: 'dependency' | 'handoff' }>
      return {
        rows: mapped,
        edges: edgeRows.map((e) => ({ from: e.d, to: e.r, kind: e.k })),
      }
    })
  }

  /** graph 内全部边的依赖邻接表(kind 不分:dependency/handoff 混合查环)。 */
  private readGraphDepsMap(graphId: string): Map<string, string[]> {
    const graphEdges = this.db
      .prepare(
        `SELECT run_id AS r, depends_on_run_id AS d FROM agent_run_edges
         WHERE run_id IN (SELECT run_id FROM agent_runs WHERE graph_id = ?)`,
      )
      .all(graphId) as Array<{ r: string; d: string }>
    const depsOf = new Map<string, string[]>()
    for (const e of graphEdges) {
      const list = depsOf.get(e.r) ?? []
      list.push(e.d)
      depsOf.set(e.r, list)
    }
    return depsOf
  }

  /**
   * 假想加入 fromRunId→deps 的新边后是否成环(在已有边之上):
   * 任一 dep 自身或其依赖闭包能回到 fromRunId 即环。graph ≤64 节点,DFS 足够。
   */
  private graphWouldCycle(graphId: string, fromRunId: string, deps: readonly string[]): boolean {
    const depsOf = this.readGraphDepsMap(graphId)
    for (const dep of deps) {
      const visited = new Set<string>()
      const stack = [dep]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (current === fromRunId) return true
        if (visited.has(current)) continue
        visited.add(current)
        for (const next of depsOf.get(current) ?? []) stack.push(next)
      }
    }
    return false
  }

  /** 调度器输入(PLAN §6.2):全部 queued run,按 (createdAt, runId) 稳定排序(防饿死)。 */
  listQueuedAgentRuns(): Promise<AgentRunRow[]> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare(`SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY created_at ASC, run_id ASC`)
        .all() as Record<string, unknown>[]
      return this.mapRowsWithDeps(rows)
    })
  }

  /** 占用并发槽的活跃 run 数(running+waiting;waiting 不释放租约也不释放槽)。 */
  countActiveRuns(): Promise<number> {
    return this.enqueue(() => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS c FROM agent_runs WHERE status IN ('running','waiting')`)
        .get() as { c: number }
      return Number(row.c)
    })
  }

  /**
   * 调度器记录排队原因(PLAN §6.2):非 queued 态必须传 null
   * (DB CHECK:status='queued' OR queue_reason IS NULL)。
   */
  setAgentRunQueueReason(
    runId: AgentRunId,
    reason: 'dependency' | 'workspace-lock' | 'concurrency-limit' | null,
  ): Promise<void> {
    return this.enqueue(() => {
      const row = this.db
        .prepare('SELECT status FROM agent_runs WHERE run_id = ?')
        .get(runId) as { status: string } | undefined
      if (!row) throw new Error(`派活不存在:${runId}`)
      if (reason !== null && row.status !== 'queued') {
        throw new Error(`只有排队中的派活才能记排队原因(当前 ${row.status})`)
      }
      this.db
        .prepare('UPDATE agent_runs SET queue_reason = ?, updated_at = ? WHERE run_id = ?')
        .run(reason, Date.now(), runId)
    })
  }

  /** followup 追加(PLAN §6.5):事务插 input + followup_count+1;run 已终态整体拒绝。 */
  appendAgentRunFollowup(input: {
    readonly runId: AgentRunId
    readonly payload: unknown
    readonly at?: number
  }): Promise<number> {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT status, followup_count AS c FROM agent_runs WHERE run_id = ?')
        .get(input.runId) as { status: string; c: number } | undefined
      if (!row) throw new Error(`派活不存在:${input.runId}`)
      if (isTerminalStatusLiteral(row.status)) {
        throw new Error('这条派活已经结束,补充要求送不进去了;请重新派活')
      }
      const at = input.at ?? Date.now()
      this.db
        .prepare(
          `INSERT INTO agent_run_inputs (input_id, run_id, kind, source_run_id, payload_json, created_at, delivered_at)
           VALUES (?, ?, 'followup', NULL, ?, ?, NULL)`,
        )
        .run(`in-${randomBytes(8).toString('hex')}`, input.runId, JSON.stringify(input.payload), at)
      this.db
        .prepare('UPDATE agent_runs SET followup_count = followup_count + 1, updated_at = ? WHERE run_id = ?')
        .run(at, input.runId)
      return row.c + 1
    })
  }

  /** 交棒落库(PLAN §6.3):同事务校验(source 同 graph 同 manager 且全部 completed、非自环)+ handoff input + handoff 边。 */
  appendAgentRunHandoff(input: {
    readonly targetRunId: AgentRunId
    readonly sourceRunIds: readonly AgentRunId[]
    readonly payload: unknown
    readonly at?: number
  }): Promise<void> {
    return this.transaction(() => {
      const target = this.db
        .prepare('SELECT graph_id, manager_session_id, status FROM agent_runs WHERE run_id = ?')
        .get(input.targetRunId) as
        | { graph_id: string; manager_session_id: string; status: string }
        | undefined
      if (!target) throw new Error(`交棒目标派活不存在:${input.targetRunId}`)
      if (isTerminalStatusLiteral(target.status)) {
        throw new Error('交棒目标已经结束,不能再接收交棒')
      }
      // 成环检测(复审整改):写 (target←source) 边前,若 source 的依赖闭包已含 target,
      // 写入即成环(如 B depends A 已存在,再交棒 A←B 就闭环)。graph ≤64 节点,DFS 足够。
      if (input.sourceRunIds.includes(input.targetRunId)) throw new Error('交棒不能以自己为来源')
      if (this.graphWouldCycle(target.graph_id, input.targetRunId, input.sourceRunIds)) {
        throw new Error('这条交棒会形成循环依赖,已拒绝')
      }
      for (const sourceId of input.sourceRunIds) {
        const source = this.db
          .prepare('SELECT graph_id, manager_session_id, status FROM agent_runs WHERE run_id = ?')
          .get(sourceId) as
          | { graph_id: string; manager_session_id: string; status: string }
          | undefined
        if (!source) throw new Error(`交棒来源派活不存在:${sourceId}`)
        if (source.graph_id !== target.graph_id) throw new Error('交棒来源不在同一条协作链上')
        if (source.manager_session_id !== target.manager_session_id) {
          throw new Error('交棒来源不属于当前总管会话')
        }
        if (source.status !== 'completed') throw new Error('交棒来源还没完成,不能交棒定论')
      }
      const at = input.at ?? Date.now()
      this.db
        .prepare(
          `INSERT INTO agent_run_inputs (input_id, run_id, kind, source_run_id, payload_json, created_at, delivered_at)
           VALUES (?, ?, 'handoff', ?, ?, ?, NULL)`,
        )
        .run(
          `in-${randomBytes(8).toString('hex')}`,
          input.targetRunId,
          input.sourceRunIds[0] ?? null,
          JSON.stringify(input.payload),
          at,
        )
      for (let i = 0; i < input.sourceRunIds.length; i++) {
        const source = input.sourceRunIds[i]!
        // 同一对 run 只留一条边:create 时落的 dependency 若与交棒同源,handoff 语义更强,覆盖之
        this.db
          .prepare(
            `INSERT INTO agent_run_edges (run_id, depends_on_run_id, kind, ordinal)
             VALUES (?, ?, 'handoff', ?)
             ON CONFLICT(run_id, depends_on_run_id) DO UPDATE SET kind = 'handoff'`,
          )
          .run(input.targetRunId, source, i)
      }
    })
  }

  /** 未投递 inputs 按 created_at 稳定取出(child 启动/steer 边界消费)。 */
  listUndeliveredAgentRunInputs(runId: AgentRunId): Promise<
    Array<{
      inputId: string
      kind: 'initial' | 'handoff' | 'followup'
      sourceRunId: AgentRunId | null
      payload: unknown
      createdAt: number
    }>
  > {
    return this.enqueue(() => {
      const rows = this.db
        .prepare(
          `SELECT input_id, kind, source_run_id, payload_json, created_at
           FROM agent_run_inputs WHERE run_id = ? AND delivered_at IS NULL
           ORDER BY created_at ASC, input_id ASC`,
        )
        .all(runId) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        inputId: String(r.input_id),
        kind: r.kind as 'initial' | 'handoff' | 'followup',
        sourceRunId: r.source_run_id == null ? null : String(r.source_run_id),
        payload: JSON.parse(String(r.payload_json)) as unknown,
        createdAt: Number(r.created_at),
      }))
    })
  }

  markAgentRunInputsDelivered(inputIds: readonly string[], at = Date.now()): Promise<void> {
    if (inputIds.length === 0) return Promise.resolve()
    return this.enqueue(() => {
      const placeholders = inputIds.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE agent_run_inputs SET delivered_at = ? WHERE input_id IN (${placeholders})`)
        .run(at, ...inputIds)
    })
  }

  // ---------- 工作区租约(PLAN §6.2:roots 重叠互斥的持久层) ----------

  /**
   * 重叠判定(PLAN §6.2 原文):canonical path 相等**或任一包含另一**(父子路径也算重叠)。
   * canonicalWorkspaceKey 输出小写正斜杠(normalizeKey);曾用反斜杠追加导致正斜杠路径的
   * 父子目录判不重叠(阶段复审阻断,探针实证)。入口先归一(反斜杠→正斜杠、
   * 小写、去尾斜杠):重叠判定宁多判(排队)不漏判(并行写灾难)。
   */
  private static rootsOverlap(a: string, b: string): boolean {
    const na = a.split('\\').join('/').toLowerCase().replace(/\/+$/, '')
    const nb = b.split('\\').join('/').toLowerCase().replace(/\/+$/, '')
    if (na === nb) return true
    return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)
  }

  /**
   * 原子获取:一个 BEGIN IMMEDIATE 事务内完成——run 资格(queued)检查、
   * 与**所有活跃 run 租约**的重叠检查(含父子路径)、写 leases、转 running。
   * 第二个竞争者必然看到第一个已落的租约/状态而被拒(串行队列+事务双保险)。
   * 返回 null=成功(已转 running);否则返回人话原因(保持 queued 由调用方记 queueReason)。
   */
  acquireLeasesAndStart(input: {
    readonly runId: AgentRunId
    readonly internalSessionId: string
    readonly canonicalRoots: readonly string[]
    readonly at?: number
  }): Promise<string | null> {
    const at = input.at ?? Date.now()
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT status, graph_id FROM agent_runs WHERE run_id = ?')
        .get(input.runId) as { status: string; graph_id: string } | undefined
      if (!row) throw new Error(`派活不存在:${input.runId}`)
      if (row.status !== 'queued') {
        throw new AgentRunTransitionError(input.runId, row.status as AgentRunStatus, 'running', '仅 queued 可启动')
      }
      // 与所有活跃 run 的租约做重叠检查(JS 侧父子包含判定,SQL 只筛活跃)
      const activeLeases = this.db
        .prepare(
          `SELECT l.run_id AS runId, l.canonical_root AS root
           FROM agent_run_workspace_leases l
           JOIN agent_runs r ON r.run_id = l.run_id
           WHERE r.status IN ('queued','running','waiting') AND l.run_id != ?`,
        )
        .all(input.runId) as Array<{ runId: string; root: string }>
      for (const lease of activeLeases) {
        for (const root of input.canonicalRoots) {
          if (RoleRepository.rootsOverlap(root, lease.root)) {
            // 冲突:状态保持 queued,只记排队原因(queued→queued 非法,不走 transition)
            this.db
              .prepare(
                `UPDATE agent_runs SET queue_reason = 'workspace-lock', updated_at = ? WHERE run_id = ?`,
              )
              .run(at, input.runId)
            return `文件夹正被另一条派活使用:${lease.root}`
          }
        }
      }
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO agent_run_workspace_leases (run_id, canonical_root, acquired_at)
         VALUES (?, ?, ?)`,
      )
      for (const root of input.canonicalRoots) insert.run(input.runId, root, at)
      this.db
        .prepare(
          `UPDATE agent_runs SET status = 'running', queue_reason = NULL,
             internal_session_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE run_id = ?`,
        )
        .run(input.internalSessionId, at, at, input.runId)
      return null
    })
  }

  /** 给定 canonical roots,返回与任一活跃 run 的租约冲突(重叠含父子路径;诊断/测试用)。 */
  findLeaseConflicts(
    canonicalRoots: readonly string[],
    excludeRunId: AgentRunId,
  ): Promise<Array<{ runId: AgentRunId; canonicalRoot: string }>> {
    return this.enqueue(() => {
      if (canonicalRoots.length === 0) return []
      const activeLeases = this.db
        .prepare(
          `SELECT l.run_id AS runId, l.canonical_root AS root
           FROM agent_run_workspace_leases l
           JOIN agent_runs r ON r.run_id = l.run_id
           WHERE r.status IN ('queued','running','waiting') AND l.run_id != ?`,
        )
        .all(excludeRunId) as Array<{ runId: string; root: string }>
      const conflicts: Array<{ runId: AgentRunId; canonicalRoot: string }> = []
      for (const lease of activeLeases) {
        for (const root of canonicalRoots) {
          if (RoleRepository.rootsOverlap(root, lease.root)) {
            conflicts.push({ runId: lease.runId, canonicalRoot: lease.root })
          }
        }
      }
      return conflicts
    })
  }

  /**
   * 独立获取租约(⚠️ 无互斥保证,生产路径禁用——启动必须走 acquireLeasesAndStart;
   * 保留 public 仅供测试直接构造租约场景)。
   */
  acquireWorkspaceLeases(
    runId: AgentRunId,
    canonicalRoots: readonly string[],
    at = Date.now(),
  ): Promise<void> {
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO agent_run_workspace_leases (run_id, canonical_root, acquired_at)
         VALUES (?, ?, ?)`,
      )
      for (const root of canonicalRoots) insert.run(runId, root, at)
    })
  }

  /** 释放租约(独立手动释放;正常终态已由 transitionAgentRun 同事务清理,这里是兜底)。 */
  releaseWorkspaceLeases(runId: AgentRunId): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare('DELETE FROM agent_run_workspace_leases WHERE run_id = ?').run(runId)
    })
  }

  /** 全部活跃租约(启动恢复诊断/测试)。 */
  listWorkspaceLeases(): Promise<Array<{ runId: AgentRunId; canonicalRoot: string; acquiredAt: number }>> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare('SELECT run_id, canonical_root, acquired_at FROM agent_run_workspace_leases')
        .all() as Array<Record<string, unknown>>
      return rows.map((r) => ({
        runId: String(r.run_id),
        canonicalRoot: String(r.canonical_root),
        acquiredAt: Number(r.acquired_at),
      }))
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

function mapAgentRunRow(
  r: Record<string, unknown>,
  repaired = false,
  dependsOnRunIds: readonly AgentRunId[] = [],
): AgentRunRow {
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
  const graphId = requireString(r.graph_id, 'graph_id')
  if (!GRAPH_ID_PATTERN.test(graphId)) throw new Error('graph_id 格式非法')
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
    graphId,
    dependsOnRunIds,
    queueReason: requireQueueReason(r.queue_reason),
    followupCount: requireNumber(r.followup_count, 'followup_count'),
    interruptSource: requireInterruptSource(r.interrupt_source),
    interruptedAt: optionalNumber(r.interrupted_at, 'interrupted_at'),
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

function requireQueueReason(
  raw: unknown,
): 'dependency' | 'workspace-lock' | 'concurrency-limit' | null {
  if (raw == null) return null
  if (raw === 'dependency' || raw === 'workspace-lock' || raw === 'concurrency-limit') return raw
  throw new Error('queue_reason 枚举非法')
}

function requireInterruptSource(raw: unknown): 'user' | 'manager' | 'app-restart' | null {
  if (raw == null) return null
  if (raw === 'user' || raw === 'manager' || raw === 'app-restart') return raw
  throw new Error('interrupt_source 枚举非法')
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
    // A-19 数据明细:可选字段,旧行没有;键存在就必须是 1~4000 字合法串(复审整改:
    // 显式 null 不能当缺省放行——解析层对同数据会整块 fallback,读层也要 fail closed 对称)
    ...('detailData' in result
      ? { detailData: requireStringLength(result.detailData, 'result.detailData', 1, 4_000) }
      : {}),
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

function requireStringLength(value: unknown, field: string, min: number, max: number): string {
  const text = requireString(value, field)
  if (text.length < min || text.length > max) throw new Error(`${field} 长度非法`)
  return text
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
