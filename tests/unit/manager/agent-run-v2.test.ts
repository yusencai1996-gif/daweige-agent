import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DelegationEnvelope } from '../../../src/shared/domain/manager'
import {
  RoleRepository,
  newGraphId,
  type InsertRoleInput,
} from '../../../src/main/roles/role-repository'

/**
 * 0.4.0 D 批 1:agent_runs v2(协作链)——迁移无损/恢复语义/坏行 fail-closed/
 * edges·inputs·leases 三表原语/graph 归属与依赖校验(PLAN §6.1/§9.6)。
 */

let dir: string
let databasePath: string
let repo: RoleRepository

const envelope: DelegationEnvelope = {
  userRequest: '整理稿件',
  managerConclusions: ['保留原意'],
  taskBrief: '把稿件整理清楚',
  acceptanceCriteria: ['结构清楚'],
  allowedWorkspacePaths: ['C:\\workspace'],
}

function workerRole(id = 'agent-a1b2c3d4e5f6'): InsertRoleInput {
  return {
    role: {
      id,
      kind: 'worker',
      displayName: '小编',
      templateId: 'writer',
      homeRelPath: `daweige/agents/${id}`,
      guardrailsRelPath: 'guardrails.md',
      createdAt: 1,
      updatedAt: 1,
    },
    mounts: [],
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-runs-v2-'))
  databasePath = join(dir, 'roles.sqlite')
  repo = new RoleRepository(databasePath)
  await repo.insertRole(workerRole())
  await repo.insertRole(workerRole('agent-b2c3d4e5f6a7'))
})

afterEach(async () => {
  await repo.drainAndClose()
  rmSync(dir, { recursive: true, force: true })
})

/** 手工造一个 v1 库(带 serial_slot),用于迁移测试。 */
function seedV1Database(): void {
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`CREATE TABLE roles (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
    template_id TEXT NOT NULL, home_rel_path TEXT NOT NULL UNIQUE,
    guardrails_rel_path TEXT NOT NULL, guardrails_version INTEGER NOT NULL DEFAULT 1,
    lifecycle TEXT NOT NULL DEFAULT 'ready', archived_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;`)
  db.exec(`CREATE TABLE agent_runs (
    run_id TEXT PRIMARY KEY, manager_session_id TEXT NOT NULL,
    target_role_id TEXT NOT NULL, target_role_name_snapshot TEXT NOT NULL,
    internal_session_id TEXT UNIQUE, parent_run_id TEXT,
    status TEXT NOT NULL, waiting_reason TEXT,
    serial_slot INTEGER UNIQUE CHECK (serial_slot IS NULL OR serial_slot = 1),
    user_request TEXT NOT NULL, manager_conclusions_json TEXT NOT NULL,
    task_brief TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
    allowed_paths_json TEXT NOT NULL, result_json TEXT,
    boundary_violations_json TEXT NOT NULL DEFAULT '[]', failure_message TEXT,
    wait_started_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER,
    completed_at INTEGER, updated_at INTEGER NOT NULL) WITHOUT ROWID;`)
  db.prepare(`INSERT INTO roles VALUES ('agent-a1b2c3d4e5f6', 'worker', '小编', 'writer',
    'daweige/agents/agent-a1b2c3d4e5f6', 'guardrails.md', 1, 'ready', NULL, 1, 1)`).run()
  db.prepare(`INSERT INTO roles VALUES ('agent-b2c3d4e5f6a7', 'worker', '账房', 'accountant',
    'daweige/agents/agent-b2c3d4e5f6a7', 'guardrails.md', 1, 'ready', NULL, 1, 1)`).run()
  const insertRun = db.prepare(`INSERT INTO agent_runs (
    run_id, manager_session_id, target_role_id, target_role_name_snapshot,
    internal_session_id, parent_run_id, status, waiting_reason, serial_slot,
    user_request, manager_conclusions_json, task_brief, acceptance_criteria_json,
    allowed_paths_json, result_json, boundary_violations_json, failure_message,
    wait_started_at, created_at, started_at, completed_at, updated_at)
    VALUES (?, 'mgr-1', 'agent-a1b2c3d4e5f6', '小编', ?, NULL, ?, NULL, ?, 
    '整理稿件', '["保留原意"]', '把稿件整理清楚', '["结构清楚"]',
    '["C:\\\\workspace"]', ?, '[]', ?, NULL, ?, ?, ?, ?)`)
  // running(占槽,非终态)/ completed / 坏 JSON 行 三类
  insertRun.run('run-1111111111111111', 'sess-internal-1', 'running', 1, null, null, 100, 100, null, 100)
  insertRun.run('run-2222222222222222', null, 'completed', null,
    '{"summary":"done","conclusions":[],"artifactPaths":[],"unmetCriteria":[],"boundaryViolations":[]}',
    null, 200, 200, 300, 300)
  db.prepare(`INSERT INTO agent_runs (
    run_id, manager_session_id, target_role_id, target_role_name_snapshot,
    internal_session_id, parent_run_id, status, waiting_reason, serial_slot,
    user_request, manager_conclusions_json, task_brief, acceptance_criteria_json,
    allowed_paths_json, result_json, boundary_violations_json, failure_message,
    wait_started_at, created_at, started_at, completed_at, updated_at)
    VALUES ('run-3333333333333333', 'mgr-1', 'agent-a1b2c3d4e5f6', '小编', NULL, NULL,
    'completed', NULL, NULL, '整理稿件', 'NOT-JSON', '把稿件整理清楚', '["结构清楚"]',
    '["C:\\\\workspace"]', NULL, '[]', NULL, NULL, 400, 400, 500, 500)`).run()
  db.close()
}

describe('agent_runs v1→v2 迁移(0.4.0 D)', () => {
  it('v1 库启动即迁移:数据无损、非终态收 interrupted(app-restart)、坏行 fail-closed 收 failed', async () => {
    // 迁移测试要"v1 库":丢掉 beforeEach 建好的 v2 库,手工造 v1 形态
    await repo.drainAndClose()
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    seedV1Database()
    repo = new RoleRepository(databasePath)
    // constructor 的迁移在 chain 队列里,第一次读操作前必然完成;drain 确保后再开新实例校验
    await repo.drainAndClose()
    repo = new RoleRepository(databasePath)

    const runs = await repo.listAgentRuns()
    expect(runs).toHaveLength(3)
    const byId = new Map(runs.map((r) => [r.runId, r]))

    // running → interrupted(app-restart),internal 会话保留
    const migrated1 = byId.get('run-1111111111111111')!
    expect(migrated1.status).toBe('interrupted')
    expect(migrated1.interruptSource).toBe('app-restart')
    expect(migrated1.interruptedAt).toBeGreaterThan(0)
    expect(migrated1.internalSessionId).toBe('sess-internal-1')
    expect(migrated1.envelope.userRequest).toBe('整理稿件')

    // completed 原样,result JSON 往返无损
    const migrated2 = byId.get('run-2222222222222222')!
    expect(migrated2.status).toBe('completed')
    expect(migrated2.result?.summary).toBe('done')
    expect(migrated2.interruptSource).toBeNull()

    // 坏 JSON 行 → failed(fail-closed,不注入模型)
    const migrated3 = byId.get('run-3333333333333333')!
    expect(migrated3.status).toBe('failed')
    expect(migrated3.failureMessage).toContain('损坏')

    // 每行独立 graph,格式合法
    for (const run of runs) {
      expect(run.graphId).toMatch(/^graph-[a-f0-9]{16}$/)
      expect(run.followupCount).toBe(0)
      expect(run.dependsOnRunIds).toEqual([])
    }
    expect(new Set(runs.map((r) => r.graphId)).size).toBe(3)

    // schema 版本=2,幂等重开不重复迁移
    expect(await repo.getMeta('manager_schema_version')).toBe('2')
    await repo.drainAndClose()
    repo = new RoleRepository(databasePath)
    expect(await repo.getMeta('manager_schema_version')).toBe('2')
    expect(await repo.listAgentRuns()).toHaveLength(3)
  })

  it('v1 脏引用迁移:坏 runId 换替身/parent 孤儿摘引用/target 孤儿补占位角色,FK 复查全清(codex 复验整改)', async () => {
    await repo.drainAndClose()
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    {
      const db = new DatabaseSync(databasePath)
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec(`CREATE TABLE roles (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
        template_id TEXT NOT NULL, home_rel_path TEXT NOT NULL UNIQUE,
        guardrails_rel_path TEXT NOT NULL, guardrails_version INTEGER NOT NULL DEFAULT 1,
        lifecycle TEXT NOT NULL DEFAULT 'ready', archived_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;`)
      db.prepare(`INSERT INTO roles VALUES ('agent-a1b2c3d4e5f6', 'worker', '小编', 'writer',
        'daweige/agents/agent-a1b2c3d4e5f6', 'guardrails.md', 1, 'ready', NULL, 1, 1)`).run()
      db.exec(`CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY, manager_session_id TEXT NOT NULL,
        target_role_id TEXT NOT NULL, target_role_name_snapshot TEXT NOT NULL,
        internal_session_id TEXT UNIQUE, parent_run_id TEXT,
        status TEXT NOT NULL, waiting_reason TEXT,
        serial_slot INTEGER UNIQUE CHECK (serial_slot IS NULL OR serial_slot = 1),
        user_request TEXT NOT NULL, manager_conclusions_json TEXT NOT NULL,
        task_brief TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL, result_json TEXT,
        boundary_violations_json TEXT NOT NULL DEFAULT '[]', failure_message TEXT,
        wait_started_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER,
        completed_at INTEGER, updated_at INTEGER NOT NULL) WITHOUT ROWID;`)
      // ①parent 孤儿(引用不存在的 run-9999…) ②坏 runId(格式非法,JSON 正常) ③target 孤儿(角色不存在)
      const insert = db.prepare(`INSERT INTO agent_runs (
        run_id, manager_session_id, target_role_id, target_role_name_snapshot,
        internal_session_id, parent_run_id, status, waiting_reason, serial_slot,
        user_request, manager_conclusions_json, task_brief, acceptance_criteria_json,
        allowed_paths_json, result_json, boundary_violations_json, failure_message,
        wait_started_at, created_at, started_at, completed_at, updated_at)
        VALUES (?, 'mgr-1', ?, ?, NULL, ?, 'completed', NULL, NULL,
        '整理', '[]', '干活', '["完成"]', '["C:\\\\workspace"]', NULL, '[]', NULL, NULL, 100, 100, 200, 200)`)
      insert.run('run-4444444444444444', 'agent-a1b2c3d4e5f6', '小编', 'run-9999999999999999')
      insert.run('bad-run-id!', 'agent-a1b2c3d4e5f6', '小编', null)
      insert.run('run-5555555555555555', 'agent-deadbeefdead', '消失的角色', null)
      db.close()
    }
    repo = new RoleRepository(databasePath)
    await repo.drainAndClose()
    repo = new RoleRepository(databasePath)

    const runs = await repo.listAgentRuns()
    expect(runs).toHaveLength(3)
    // 所有进 v2 的 runId 都是合法格式(坏 runId 换了确定性替身,原值不残留)
    for (const run of runs) expect(run.runId).toMatch(/^run-[a-f0-9]{16}$/)
    expect(runs.some((r) => r.runId === 'bad-run-id!')).toBe(false)

    // parent 孤儿:引用被摘
    expect(runs.find((r) => r.runId === 'run-4444444444444444')?.parentRunId).toBeNull()
    // target 孤儿:收 failed 留档
    const orphan = runs.find((r) => r.runId === 'run-5555555555555555')
    expect(orphan?.status).toBe('failed')
    expect(orphan?.failureMessage).toContain('引用残缺')

    // roles 表补了 legacy-unresolved 占位(FK 消除),FK 复查零 violation
    const db = new DatabaseSync(databasePath)
    try {
      const placeholder = db
        .prepare("SELECT kind, archived_at FROM roles WHERE id = 'agent-deadbeefdead'")
        .get() as { kind: string; archived_at: number } | undefined
      expect(placeholder?.kind).toBe('legacy-unresolved')
      expect(placeholder?.archived_at).not.toBeNull()
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('协作链原语(edges/inputs/leases)', () => {
  it('rootsOverlap 认真实 canonical 输出:正斜杠父子算冲突,同前缀非父子放行(codex 阶段复审阻断回归)', async () => {
    const { canonicalWorkspaceKey } = await import('../../../src/main/roles/role-files')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'inner-ws'), { recursive: true })
    mkdirSync(join(dir, 'nested-x'), { recursive: true })
    const root = await canonicalWorkspaceKey(dir)
    const inner = await canonicalWorkspaceKey(join(dir, 'inner-ws'))
    const sibling = await canonicalWorkspaceKey(join(dir, 'nested-x'))
    // canonical 输出必为小写正斜杠(正是曾被反斜杠逻辑判漏的生产形态)
    expect(root).toMatch(/^[a-z]:\//)

    const seed = async (runId: string) => {
      await repo.createAgentRun({
        runId,
        managerSessionId: 'mgr-1',
        targetRoleId: 'agent-a1b2c3d4e5f6',
        targetRoleNameSnapshot: '小编',
        envelope,
      })
      await repo.transitionAgentRun(runId, { status: 'queued' })
    }
    // A 持子目录 → B 持父目录(canonical 正斜杠,包含关系反向):必须冲突留 queued
    await seed('run-aaaaaaaaaaaaaaaa')
    await repo.acquireLeasesAndStart({ runId: 'run-aaaaaaaaaaaaaaaa', internalSessionId: 's-a', canonicalRoots: [inner] })
    await seed('run-bbbbbbbbbbbbbbbb')
    const conflict = await repo.acquireLeasesAndStart({ runId: 'run-bbbbbbbbbbbbbbbb', internalSessionId: 's-b', canonicalRoots: [root] })
    expect(conflict).toContain('正被另一条派活使用')
    expect((await repo.getAgentRun('run-bbbbbbbbbbbbbbbb'))?.queueReason).toBe('workspace-lock')
    // 互不包含的兄弟目录(nested-x vs inner-ws):放行
    await seed('run-cccccccccccccccc')
    const ok = await repo.acquireLeasesAndStart({ runId: 'run-cccccccccccccccc', internalSessionId: 's-c', canonicalRoots: [sibling] })
    expect(ok).toBeNull()
  })

  it('createAgentRun 缺省生成单节点 graph;显式传 graphId 复用并校验归属', async () => {
    const first = await repo.createAgentRun({
      runId: 'run-aaaaaaaaaaaaaaaa',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    expect(first.graphId).toMatch(/^graph-[a-f0-9]{16}$/)
    expect(first.dependsOnRunIds).toEqual([])
    // 显式同 graph 复用(依赖前一条)
    await repo.transitionAgentRun('run-aaaaaaaaaaaaaaaa', { status: 'rejected' })
    const second = await repo.createAgentRun({
      runId: 'run-bbbbbbbbbbbbbbbb',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-b2c3d4e5f6a7',
      targetRoleNameSnapshot: '账房',
      graphId: first.graphId,
      dependsOnRunIds: ['run-aaaaaaaaaaaaaaaa'],
      envelope,
    })
    expect(second.graphId).toBe(first.graphId)
    expect(second.dependsOnRunIds).toEqual(['run-aaaaaaaaaaaaaaaa'])
    // 过渡期单活语义:建完先收终态,后续 create 才能进(调度器批会放开)
    await repo.transitionAgentRun('run-bbbbbbbbbbbbbbbb', { status: 'rejected' })
    // 非法 graphId 格式直接拒
    await expect(
      repo.createAgentRun({
        runId: 'run-cccccccccccccccc',
        managerSessionId: 'mgr-1',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleNameSnapshot: '账房',
        graphId: 'graph-not-hex!!',
        envelope,
      }),
    ).rejects.toThrow('协作链编号格式不合法')
    // 跨 manager 复用 graph 拒绝
    await expect(
      repo.createAgentRun({
        runId: 'run-dddddddddddddddd',
        managerSessionId: 'mgr-other',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleNameSnapshot: '账房',
        graphId: first.graphId,
        envelope,
      }),
    ).rejects.toThrow('不属于当前总管会话')
    // 自环依赖拒绝
    await expect(
      repo.createAgentRun({
        runId: 'run-eeeeeeeeeeeeeeee',
        managerSessionId: 'mgr-1',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleNameSnapshot: '账房',
        graphId: first.graphId,
        dependsOnRunIds: ['run-eeeeeeeeeeeeeeee'],
        envelope,
      }),
    ).rejects.toThrow('依赖自己')
    // 跨 graph 依赖拒绝
    const other = await repo.createAgentRun({
      runId: 'run-ffffffffffffffff',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-b2c3d4e5f6a7',
      targetRoleNameSnapshot: '账房',
      envelope,
    })
    await expect(
      repo.createAgentRun({
        runId: 'run-1234567890abcdef',
        managerSessionId: 'mgr-1',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleNameSnapshot: '账房',
        graphId: other.graphId,
        dependsOnRunIds: ['run-bbbbbbbbbbbbbbbb'],
        envelope,
      }),
    ).rejects.toThrow('不在同一条协作链')
  })

  it('followup:活跃 run 追加计数+落 input;终态整体拒绝', async () => {
    const run = await repo.createAgentRun({
      runId: 'run-4444444444444444',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    const count1 = await repo.appendAgentRunFollowup({
      runId: 'run-4444444444444444',
      payload: { message: '顺便把标题也改了' },
    })
    expect(count1).toBe(1)
    const inputs = await repo.listUndeliveredAgentRunInputs('run-4444444444444444')
    // initial(创建时落)+ followup(追加)
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.kind).toBe('initial')
    expect(inputs[1]?.kind).toBe('followup')
    expect((inputs[1]?.payload as { message: string }).message).toContain('标题')
    // 投递标记
    await repo.markAgentRunInputsDelivered(inputs.map((i) => i.inputId))
    expect(await repo.listUndeliveredAgentRunInputs('run-4444444444444444')).toHaveLength(0)
    // 终态拒绝
    await repo.transitionAgentRun('run-4444444444444444', { status: 'queued' })
    await repo.transitionAgentRun('run-4444444444444444', {
      status: 'running',
      internalSessionId: 'sess-run4',
    })
    await repo.transitionAgentRun('run-4444444444444444', {
      status: 'failed',
      failureMessage: '验收不过',
    })
    await expect(
      repo.appendAgentRunFollowup({ runId: 'run-4444444444444444', payload: { message: 'x' } }),
    ).rejects.toThrow('已经结束')
    const after = await repo.getAgentRun('run-4444444444444444')
    expect(after?.followupCount).toBe(1)
    expect(run.dependsOnRunIds).toEqual([])
  })

  it('handoff:input+边同事务落库;getAgentRunGraph 返回节点与边', async () => {
    const graphId = newGraphId()
    await repo.createAgentRun({
      runId: 'run-5555555555555555',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      graphId,
      envelope,
    })
    await repo.transitionAgentRun('run-5555555555555555', { status: 'queued' })
    await repo.transitionAgentRun('run-5555555555555555', {
      status: 'running',
      internalSessionId: 'sess-run5',
    })
    await repo.transitionAgentRun('run-5555555555555555', {
      status: 'completed',
      result: {
        summary: '稿子整理完了',
        conclusions: ['结构已整理'],
        artifactPaths: [],
        unmetCriteria: [],
        boundaryViolations: [],
      },
    })
    // 过渡期单活:上一条收终态后,交棒下游(依赖边在 create 落,handoff input+边由 append 补)
    await repo.createAgentRun({
      runId: 'run-6666666666666666',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-b2c3d4e5f6a7',
      targetRoleNameSnapshot: '账房',
      graphId,
      dependsOnRunIds: ['run-5555555555555555'],
      envelope,
    })
    await repo.appendAgentRunHandoff({
      targetRunId: 'run-6666666666666666',
      sourceRunIds: ['run-5555555555555555'],
      payload: { schemaVersion: 1, conclusions: ['已完成'] },
    })
    const graph = await repo.getAgentRunGraph(graphId)
    expect(graph.rows.map((r) => r.runId).sort()).toEqual(['run-5555555555555555', 'run-6666666666666666'])
    // 同一对 run 只留一条边:handoff 语义更强,覆盖 create 时落的 dependency
    expect(graph.edges).toEqual([
      { from: 'run-5555555555555555', to: 'run-6666666666666666', kind: 'handoff' },
    ])
    const handoffInputs = await repo.listUndeliveredAgentRunInputs('run-6666666666666666')
    expect(handoffInputs.map((i) => i.kind).sort()).toEqual(['handoff', 'initial'])
  })

  it('leases:冲突检测按活跃 run;释放幂等;恢复时清孤儿', async () => {
    await repo.createAgentRun({
      runId: 'run-7777777777777777',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    await repo.transitionAgentRun('run-7777777777777777', { status: 'queued' })
    await repo.transitionAgentRun('run-7777777777777777', {
      status: 'running',
      internalSessionId: 'sess-run7',
    })
    await repo.acquireWorkspaceLeases('run-7777777777777777', ['C:\\ws\\reports'])
    // 活跃 run 持有 → 同根冲突
    const conflicts = await repo.findLeaseConflicts(['C:\\ws\\reports'], 'run-8888888888888888')
    expect(conflicts).toEqual([{ runId: 'run-7777777777777777', canonicalRoot: 'C:\\ws\\reports' }])
    // 不同根不冲突;自己排除
    expect(await repo.findLeaseConflicts(['C:\\ws\\other'], 'run-8888888888888888')).toEqual([])
    expect(await repo.findLeaseConflicts(['C:\\ws\\reports'], 'run-7777777777777777')).toEqual([])
    // 终态释放后不冲突
    await repo.transitionAgentRun('run-7777777777777777', {
      status: 'completed',
      result: {
        summary: 'done',
        conclusions: [],
        artifactPaths: [],
        unmetCriteria: [],
        boundaryViolations: [],
      },
    })
    await repo.releaseWorkspaceLeases('run-7777777777777777')
    expect(await repo.findLeaseConflicts(['C:\\ws\\reports'], 'run-8888888888888888')).toEqual([])
    // 孤儿 lease 由启动恢复清理
    await repo.acquireWorkspaceLeases('run-7777777777777777', ['C:\\ws\\stale'])
    await repo.recoverInterruptedAgentRuns()
    expect(await repo.listWorkspaceLeases()).toEqual([])
  })

  it('queued 可带 queueReason;interrupted 带 source(表级 CHECK 语义在 transition 层落地)', async () => {
    const run = await repo.createAgentRun({
      runId: 'run-9999999999999999',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    const queued = await repo.transitionAgentRun('run-9999999999999999', {
      status: 'queued',
      queueReason: 'workspace-lock',
    })
    expect(queued.queueReason).toBe('workspace-lock')
    const running = await repo.transitionAgentRun('run-9999999999999999', {
      status: 'running',
      internalSessionId: 'sess-run9',
    })
    expect(running.queueReason).toBeNull()
    const interrupted = await repo.transitionAgentRun('run-9999999999999999', {
      status: 'interrupted',
      failureMessage: '用户打断了',
      interruptSource: 'user',
    })
    expect(interrupted.interruptSource).toBe('user')
    expect(interrupted.interruptedAt).toBeGreaterThan(0)
    expect(run.graphId).toMatch(/^graph-[a-f0-9]{16}$/)
  })

  it('acquireLeasesAndStart 原子启动:父子路径重叠也算冲突;终态自动释放租约(独立复审整改回归)', async () => {
    // run-A 占 C:\ws\reports(经原子启动)
    await repo.createAgentRun({
      runId: 'run-aaaaaaaaaaaaaaaa',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: { ...envelope, allowedWorkspacePaths: ['C:\\ws\\reports'] },
    })
    await repo.transitionAgentRun('run-aaaaaaaaaaaaaaaa', { status: 'queued' })
    const startA = await repo.acquireLeasesAndStart({
      runId: 'run-aaaaaaaaaaaaaaaa',
      internalSessionId: 'sess-a',
      canonicalRoots: ['C:\\ws\\reports'],
    })
    expect(startA).toBeNull()
    const afterA = await repo.getAgentRun('run-aaaaaaaaaaaaaaaa')
    expect(afterA?.status).toBe('running')
    await repo.transitionAgentRun('run-aaaaaaaaaaaaaaaa', {
      status: 'completed',
      result: { summary: 'done', conclusions: [], artifactPaths: [], unmetCriteria: [], boundaryViolations: [] },
    })

    // run-B 同根 → 冲突;父子根(C:\ws 与 C:\ws\reports)也冲突 → 保持 queued
    // (单活闸门只挡 queued/running/waiting:B/C 先以 awaiting 并存,再逐个启动)
    await repo.createAgentRun({
      runId: 'run-bbbbbbbbbbbbbbbb',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: { ...envelope, allowedWorkspacePaths: ['C:\\ws\\reports'] },
    })
    await repo.createAgentRun({
      runId: 'run-cccccccccccccccc',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope: { ...envelope, allowedWorkspacePaths: ['C:\\ws'] },
    })
    await repo.transitionAgentRun('run-bbbbbbbbbbbbbbbb', { status: 'queued' })
    const startB = await repo.acquireLeasesAndStart({
      runId: 'run-bbbbbbbbbbbbbbbb',
      internalSessionId: 'sess-b',
      canonicalRoots: ['C:\\ws\\reports'],
    })
    expect(startB).toBeNull()
    // run-B 活跃期间,run-C 想要父目录 C:\ws(父子重叠)→ 冲突拒绝
    await repo.transitionAgentRun('run-cccccccccccccccc', { status: 'queued' })
    const conflict = await repo.acquireLeasesAndStart({
      runId: 'run-cccccccccccccccc',
      internalSessionId: 'sess-c',
      canonicalRoots: ['C:\\ws'],
    })
    expect(conflict).toContain('正被另一条派活使用')
    const afterC = await repo.getAgentRun('run-cccccccccccccccc')
    expect(afterC?.status).toBe('queued')
    // findLeaseConflicts 同款重叠语义
    const conflicts = await repo.findLeaseConflicts(['C:\\ws'], 'run-cccccccccccccccc')
    expect(conflicts).toEqual([{ runId: 'run-bbbbbbbbbbbbbbbb', canonicalRoot: 'C:\\ws\\reports' }])
    // interrupt 走 transition 终态 → lease 同事务释放
    await repo.transitionAgentRun('run-bbbbbbbbbbbbbbbb', {
      status: 'interrupted',
      failureMessage: '用户打断了',
      interruptSource: 'user',
    })
    expect(await repo.listWorkspaceLeases()).toEqual([])
  })

  it('handoff 校验:自环/来源未完成拒绝;合法交棒落库(独立复审整改回归)', async () => {
    const graphId = newGraphId()
    // source-d:先停在 running(未完成)
    await repo.createAgentRun({
      runId: 'run-dddddddddddddddd',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      graphId,
      envelope,
    })
    await repo.transitionAgentRun('run-dddddddddddddddd', { status: 'queued' })
    await repo.transitionAgentRun('run-dddddddddddddddd', {
      status: 'running',
      internalSessionId: 'sess-d',
    })
    // 自环拒
    await expect(
      repo.appendAgentRunHandoff({
        targetRunId: 'run-dddddddddddddddd',
        sourceRunIds: ['run-dddddddddddddddd'],
        payload: {},
      }),
    ).rejects.toThrow('不能以自己为来源')
    // 另一条非 completed 来源(g 被 rejected,没有定论)→ 拒"还没完成"
    await repo.transitionAgentRun('run-dddddddddddddddd', {
      status: 'completed',
      result: { summary: 'done', conclusions: ['已理账'], artifactPaths: [], unmetCriteria: [], boundaryViolations: [] },
    })
    const g = await repo.createAgentRun({
      runId: 'run-1a2b3c4d5e6f0001',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-b2c3d4e5f6a7',
      targetRoleNameSnapshot: '账房',
      graphId,
      envelope,
    })
    await repo.transitionAgentRun('run-1a2b3c4d5e6f0001', { status: 'rejected' })
    expect(g.graphId).toBe(graphId)
    const f = await repo.createAgentRun({
      runId: 'run-eeeeeeeeeeeeeeee',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-b2c3d4e5f6a7',
      targetRoleNameSnapshot: '账房',
      graphId,
      dependsOnRunIds: ['run-dddddddddddddddd'],
      envelope,
    })
    // 单活占位:f 还 awaiting,先验证"来源未完成"再收尾
    await expect(
      repo.appendAgentRunHandoff({
        targetRunId: 'run-eeeeeeeeeeeeeeee',
        sourceRunIds: ['run-1a2b3c4d5e6f0001'],
        payload: {},
      }),
    ).rejects.toThrow('还没完成')
    await expect(
      repo.appendAgentRunHandoff({
        targetRunId: 'run-eeeeeeeeeeeeeeee',
        sourceRunIds: ['run-eeeeeeeeeeeeeeee'],
        payload: {},
      }),
    ).rejects.toThrow('不能以自己为来源')
    // 合法交棒:d completed + 同 graph
    await repo.appendAgentRunHandoff({
      targetRunId: 'run-eeeeeeeeeeeeeeee',
      sourceRunIds: ['run-dddddddddddddddd'],
      payload: { schemaVersion: 1, conclusions: ['已理账'] },
    })
    const inputs = await repo.listUndeliveredAgentRunInputs('run-eeeeeeeeeeeeeeee')
    expect(inputs.some((i) => i.kind === 'handoff' && i.sourceRunId === 'run-dddddddddddddddd')).toBe(true)
    const graph = await repo.getAgentRunGraph(graphId)
    expect(graph.edges).toContainEqual({
      from: 'run-dddddddddddddddd',
      to: 'run-eeeeeeeeeeeeeeee',
      kind: 'handoff',
    })
    expect(f.graphId).toBe(graphId)
  })

  it('parentRunId 跨图拒绝(独立复审整改回归)', async () => {
    await repo.createAgentRun({
      runId: 'run-1234567890abc003',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    await repo.transitionAgentRun('run-1234567890abc003', { status: 'rejected' })
    const otherGraph = await repo.createAgentRun({
      runId: 'run-1234567890abc004',
      managerSessionId: 'mgr-1',
      targetRoleId: 'agent-a1b2c3d4e5f6',
      targetRoleNameSnapshot: '小编',
      envelope,
    })
    await repo.transitionAgentRun('run-1234567890abc004', { status: 'rejected' })
    await expect(
      repo.createAgentRun({
        runId: 'run-1234567890abc005',
        managerSessionId: 'mgr-1',
        targetRoleId: 'agent-a1b2c3d4e5f6',
        targetRoleNameSnapshot: '小编',
        parentRunId: 'run-1234567890abc003',
        graphId: otherGraph.graphId,
        envelope,
      }),
    ).rejects.toThrow('不在同一条协作链')
  })
})
