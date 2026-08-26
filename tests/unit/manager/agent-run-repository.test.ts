import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentRunStatus,
  DelegationEnvelope,
  DelegationResult,
} from '../../../src/shared/domain/manager'
import {
  AgentRunSlotOccupiedError,
  AgentRunTransitionError,
  RoleAgentRunBusyError,
  RoleRepository,
  type AgentRunTransition,
  type InsertRoleInput,
} from '../../../src/main/roles/role-repository'

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

const result: DelegationResult = {
  summary: '已完成',
  conclusions: ['结构已整理'],
  artifactPaths: ['C:\\workspace\\done.md'],
  unmetCriteria: [],
  boundaryViolations: [],
}

function roleInput(): InsertRoleInput {
  return {
    role: {
      id: 'agent-a1b2c3d4e5f6',
      kind: 'worker',
      displayName: '小编',
      templateId: 'writer',
      homeRelPath: 'daweige/agents/agent-a1b2c3d4e5f6',
      guardrailsRelPath: 'guardrails.md',
      createdAt: 1,
      updatedAt: 1,
    },
    mounts: [],
  }
}

async function spawn(runId = 'run-0000000000000001', createdAt = 1) {
  return repo.createAgentRun({
    runId,
    managerSessionId: 'manager-session',
    targetRoleId: 'agent-a1b2c3d4e5f6',
    targetRoleNameSnapshot: '小编',
    envelope,
    createdAt,
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-runs-'))
  databasePath = join(dir, 'roles.sqlite')
  repo = new RoleRepository(databasePath)
  await repo.insertRole(roleInput())
})

afterEach(async () => {
  await repo.drainAndClose()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent_runs schema 与串行槽', () => {
  it('createAgentRun 落库前拒绝非法 envelope,不留下占槽行', async () => {
    // createAgentRun 非 async:校验在返回 promise 前同步抛(快速失败),用 toThrow 包函数断言
    expect(() =>
      repo.createAgentRun({
        runId: 'run-invalid-envelope',
        managerSessionId: 'manager-session',
        targetRoleId: 'agent-a1b2c3d4e5f6',
        targetRoleNameSnapshot: '小编',
        envelope: { ...envelope, allowedWorkspacePaths: ['relative-path'] },
      }),
    ).toThrow('allowed_paths_json 内容非法')
    expect(await repo.listAgentRuns()).toEqual([])
  })

  it('建表和 schema 版本幂等,DDL 为 WITHOUT ROWID 且三个索引齐全', async () => {
    expect(await repo.getMeta('manager_schema_version')).toBe('1')
    await repo.drainAndClose()
    repo = new RoleRepository(databasePath)
    expect(await repo.getMeta('manager_schema_version')).toBe('1')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").get() as { sql: string }
      expect(table.sql).toContain('WITHOUT ROWID')
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_runs'").all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'idx_agent_runs_manager_created',
          'idx_agent_runs_target',
          'idx_agent_runs_internal',
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('并发 spawn 只有一个占槽,终态释放后下一条可进入', async () => {
    const settled = await Promise.allSettled([
      spawn('run-0000000000000001'),
      spawn('run-0000000000000002'),
    ])
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((item) => item.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(
      AgentRunSlotOccupiedError,
    )
    const active = (await repo.listAgentRuns())[0]!
    await repo.transitionAgentRun(active.runId, { status: 'rejected' })
    await expect(spawn('run-0000000000000003')).resolves.toMatchObject({
      status: 'awaiting-approval',
    })
  })

  it('事务内联查角色状态，归档或删除中的 worker 不能新占槽', async () => {
    await repo.setRoleArchived('agent-a1b2c3d4e5f6', 2, 2)
    await expect(spawn()).rejects.toThrow('目标角色刚被删除或归档')
    expect(await repo.listAgentRuns()).toEqual([])

    await repo.setRoleArchived('agent-a1b2c3d4e5f6', null, 3)
    await repo.setRoleLifecycle('agent-a1b2c3d4e5f6', 'deleting', 4)
    await expect(spawn()).rejects.toThrow('目标角色刚被删除或归档')
    expect(await repo.listAgentRuns()).toEqual([])
  })

  it('归档/删除行动侧也在事务内拒绝刚插入的活跃 run', async () => {
    await spawn()
    await expect(
      repo.archiveRoleIfIdle('agent-a1b2c3d4e5f6', 2, 2),
    ).rejects.toBeInstanceOf(RoleAgentRunBusyError)
    await expect(
      repo.beginDeletionTransaction('agent-a1b2c3d4e5f6', 'confirmed', []),
    ).rejects.toBeInstanceOf(RoleAgentRunBusyError)
    expect(await repo.getRoleRow('agent-a1b2c3d4e5f6')).toMatchObject({
      archivedAt: null,
      lifecycle: 'ready',
    })
  })

  it('按 createdAt、runId 稳定排序', async () => {
    await spawn('run-0000000000000002', 10)
    await repo.transitionAgentRun('run-0000000000000002', { status: 'rejected', at: 11 })
    await spawn('run-0000000000000001', 10)
    await repo.transitionAgentRun('run-0000000000000001', { status: 'rejected', at: 11 })
    await spawn('run-0000000000000003', 9)
    expect((await repo.listAgentRuns()).map((row) => row.runId)).toEqual([
      'run-0000000000000003',
      'run-0000000000000001',
      'run-0000000000000002',
    ])
  })
})

describe('agent_runs 状态机', () => {
  it('状态图中的每条合法边都可转换', async () => {
    const legal: ReadonlyArray<readonly [AgentRunStatus, AgentRunStatus]> = [
      ['awaiting-approval', 'queued'],
      ['awaiting-approval', 'rejected'],
      ['awaiting-approval', 'interrupted'],
      ['queued', 'running'],
      ['queued', 'failed'],
      ['queued', 'interrupted'],
      ['running', 'waiting'],
      ['running', 'completed'],
      ['running', 'failed'],
      ['running', 'interrupted'],
      ['waiting', 'running'],
      ['waiting', 'waiting'],
      ['waiting', 'completed'],
      ['waiting', 'failed'],
      ['waiting', 'interrupted'],
    ]
    for (const [from, to] of legal) {
      await repo.drainAndClose()
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(tmpdir(), 'agent-runs-legal-'))
      databasePath = join(dir, 'roles.sqlite')
      repo = new RoleRepository(databasePath)
      await repo.insertRole(roleInput())
      await spawn()
      await moveTo(from)
      await expect(
        repo.transitionAgentRun('run-0000000000000001', transitionFor(to)),
        `${from} -> ${to}`,
      ).resolves.toMatchObject({ status: to })
    }
  })

  it('每条合法转换写齐状态、reason、internal session、时间戳与结果', async () => {
    await spawn()
    expect(await repo.transitionAgentRun('run-0000000000000001', { status: 'queued', at: 2 })).toMatchObject({ status: 'queued' })
    expect(
      await repo.transitionAgentRun('run-0000000000000001', {
        status: 'running',
        internalSessionId: 'internal-1',
        at: 3,
      }),
    ).toMatchObject({ status: 'running', internalSessionId: 'internal-1', startedAt: 3 })
    expect(
      await repo.transitionAgentRun('run-0000000000000001', {
        status: 'waiting',
        waitingReason: 'user-approval',
        at: 4,
      }),
    ).toMatchObject({ status: 'waiting', waitingReason: 'user-approval', waitStartedAt: 4 })
    expect(
      await repo.transitionAgentRun('run-0000000000000001', {
        status: 'waiting',
        waitingReason: 'manager-wait',
        at: 5,
      }),
    ).toMatchObject({ status: 'waiting', waitingReason: 'manager-wait', waitStartedAt: 5 })
    expect(
      await repo.transitionAgentRun('run-0000000000000001', { status: 'running', at: 6 }),
    ).toMatchObject({ status: 'running', waitingReason: null, startedAt: 3 })
    expect(
      await repo.transitionAgentRun('run-0000000000000001', {
        status: 'completed',
        result,
        at: 7,
      }),
    ).toMatchObject({ status: 'completed', result, completedAt: 7 })
  })

  it('internal session 可反查 run,越界事实立即追加且包含工具名', async () => {
    await spawn()
    await repo.transitionAgentRun('run-0000000000000001', { status: 'queued', at: 2 })
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'running',
      internalSessionId: 'internal-violation',
      at: 3,
    })
    expect(await repo.getAgentRunByInternalSession('internal-violation')).toMatchObject({
      runId: 'run-0000000000000001',
    })
    await repo.appendAgentRunBoundaryViolation('run-0000000000000001', {
      path: 'C:\\outside\\secret.txt',
      toolName: 'read_file',
      operation: 'read',
      reason: '路径越界',
      occurredAt: 4,
    })
    expect((await repo.getAgentRun('run-0000000000000001'))?.boundaryViolations).toEqual([
      {
        path: 'C:\\outside\\secret.txt',
        toolName: 'read_file',
        operation: 'read',
        reason: '路径越界',
        occurredAt: 4,
      },
    ])
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'waiting',
      waitingReason: 'manager-wait',
      at: 5,
    })
    expect((await repo.getAgentRun('run-0000000000000001'))?.boundaryViolations).toHaveLength(1)
  })

  it('awaiting 可拒绝;queued/running/waiting 可失败或中断', async () => {
    await spawn()
    expect(await repo.transitionAgentRun('run-0000000000000001', { status: 'rejected', at: 2 })).toMatchObject({ status: 'rejected', completedAt: 2 })
  })

  it('无 internal 会话不能进入 running', async () => {
    await spawn()
    await repo.transitionAgentRun('run-0000000000000001', { status: 'queued' })
    await expect(
      repo.transitionAgentRun('run-0000000000000001', { status: 'running' }),
    ).rejects.toBeInstanceOf(AgentRunTransitionError)
  })

  it('完整非法转换矩阵均抛 AgentRunTransitionError', async () => {
    const legal: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
      'awaiting-approval': ['queued', 'rejected', 'interrupted'],
      queued: ['running', 'failed', 'interrupted'],
      running: ['waiting', 'completed', 'failed', 'interrupted'],
      waiting: ['running', 'waiting', 'completed', 'failed', 'interrupted'],
      completed: [], failed: [], rejected: [], interrupted: [],
    }
    const statuses = Object.keys(legal) as AgentRunStatus[]
    for (const current of statuses) {
      await repo.drainAndClose()
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(tmpdir(), 'agent-runs-matrix-'))
      databasePath = join(dir, 'roles.sqlite')
      repo = new RoleRepository(databasePath)
      await repo.insertRole(roleInput())
      await spawn()
      await moveTo(current)
      for (const next of statuses.filter((status) => !legal[current].includes(status))) {
        await expect(
          repo.transitionAgentRun('run-0000000000000001', transitionFor(next)),
          `${current} -> ${next}`,
        ).rejects.toBeInstanceOf(AgentRunTransitionError)
      }
    }
  })
})

describe('agent_runs 恢复与损坏数据', () => {
  for (const status of ['awaiting-approval', 'queued', 'running', 'waiting'] as const) {
    it(`启动恢复把 ${status} 收成 interrupted`, async () => {
      await spawn()
      await moveTo(status)
      const recovered = await repo.recoverInterruptedAgentRuns(99)
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({
        status: 'interrupted',
        waitingReason: null,
        completedAt: 99,
        failureMessage: '应用上次在派活中途退出，本次没有自动继续',
      })
    })
  }

  it('终态不被启动恢复误改', async () => {
    await spawn()
    await repo.transitionAgentRun('run-0000000000000001', { status: 'rejected', at: 2 })
    expect(await repo.recoverInterruptedAgentRuns(99)).toEqual([])
    expect((await repo.getAgentRun('run-0000000000000001'))?.status).toBe('rejected')
  })

  it('JSON 损坏 fail-closed:标 failed、释放槽且不返回脏数组', async () => {
    await spawn()
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("UPDATE agent_runs SET allowed_paths_json = '{坏' WHERE run_id = ?").run(
        'run-0000000000000001',
      )
    } finally {
      db.close()
    }
    const row = await repo.getAgentRun('run-0000000000000001')
    expect(row).toMatchObject({
      status: 'failed',
      failureMessage: '派活记录数据损坏，已安全停止',
    })
    await expect(spawn('run-0000000000000002')).resolves.toBeDefined()
  })

  it('删除目标角色级联删除历史 run', async () => {
    await spawn()
    await repo.transitionAgentRun('run-0000000000000001', { status: 'rejected' })
    await repo.deleteRoleRow('agent-a1b2c3d4e5f6')
    expect(await repo.listAgentRuns()).toEqual([])
  })
})

async function moveTo(status: AgentRunStatus): Promise<void> {
  if (status === 'awaiting-approval') return
  if (status === 'rejected') {
    await repo.transitionAgentRun('run-0000000000000001', { status: 'rejected' })
    return
  }
  if (status === 'interrupted') {
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'interrupted',
      failureMessage: '中断',
    })
    return
  }
  await repo.transitionAgentRun('run-0000000000000001', { status: 'queued' })
  if (status === 'queued') return
  if (status === 'failed') {
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'failed',
      failureMessage: '失败',
    })
    return
  }
  await repo.transitionAgentRun('run-0000000000000001', {
    status: 'running',
    internalSessionId: 'internal-1',
  })
  if (status === 'running') return
  if (status === 'waiting') {
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'waiting',
      waitingReason: 'manager-wait',
    })
    return
  }
  await repo.transitionAgentRun('run-0000000000000001', { status: 'completed', result })
}

function transitionFor(status: AgentRunStatus): AgentRunTransition {
  switch (status) {
    case 'queued': return { status }
    case 'running': return { status, internalSessionId: 'internal-next' }
    case 'waiting': return { status, waitingReason: 'manager-wait' }
    case 'completed': return { status, result }
    case 'failed': return { status, failureMessage: '失败' }
    case 'rejected': return { status }
    case 'interrupted': return { status, failureMessage: '中断' }
    case 'awaiting-approval':
      // 运行时恶意/失控调用仍可能绕过 TS;仓储必须自己拒绝回跳 awaiting。
      return { status: 'awaiting-approval' } as unknown as AgentRunTransition
  }
}
