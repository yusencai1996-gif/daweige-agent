import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DelegationEnvelope } from '../../../src/shared/domain/manager'
import {
  RoleRepository,
  type AgentRunRow,
  type InsertRoleInput,
} from '../../../src/main/roles/role-repository'
import {
  AgentRunScheduler,
  type TryStartOutcome,
} from '../../../src/main/manager/agent-run-scheduler'

/**
 * 0.4.0 D 调度器批(PLAN §6.2/§9.6):并发上限/依赖等待/失败级联/公平排序/
 * lease-conflict 不占槽/移除单活闸门后的 repository 上限。
 * tryStart 用真 DB 转换的 mock(不建 internal 会话),验证调度决策层。
 */

let dir: string
let repo: RoleRepository
let tryStartCalls: string[]
let cascaded: string[]
let tryStartImpl: (run: AgentRunRow) => Promise<TryStartOutcome>

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
  dir = mkdtempSync(join(tmpdir(), 'agent-run-scheduler-'))
  repo = new RoleRepository(join(dir, 'roles.sqlite'))
  await repo.insertRole(workerRole())
  tryStartCalls = []
  cascaded = []
  tryStartImpl = async (run) => {
    tryStartCalls.push(run.runId)
    try {
      await repo.transitionAgentRun(run.runId, {
        status: 'running',
        internalSessionId: `internal-${run.runId}`,
      })
      return 'started'
    } catch {
      return 'gone'
    }
  }
})

afterEach(async () => {
  await repo.drainAndClose()
  rmSync(dir, { recursive: true, force: true })
})

function makeScheduler(): AgentRunScheduler {
  return new AgentRunScheduler({
    roles: repo,
    tryStart: (run) => tryStartImpl(run),
    onCascadeFailed: (run) => {
      cascaded.push(run.runId)
    },
  })
}

interface SeedOptions {
  readonly status?: 'awaiting-approval' | 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  readonly deps?: readonly string[]
  readonly graphId?: string
  readonly createdAt?: number
}

/** 造 run 并沿合法状态机推进到目标态(running 用直转,不经租约)。 */
async function seedRun(runId: string, options: SeedOptions = {}): Promise<AgentRunRow> {
  await repo.createAgentRun({
    runId,
    managerSessionId: 'manager-session',
    targetRoleId: 'agent-a1b2c3d4e5f6',
    targetRoleNameSnapshot: '小编',
    envelope,
    ...(options.graphId !== undefined ? { graphId: options.graphId } : {}),
    ...(options.deps !== undefined ? { dependsOnRunIds: options.deps } : {}),
    ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
  })
  const status = options.status ?? 'awaiting-approval'
  if (status !== 'awaiting-approval') {
    await repo.transitionAgentRun(runId, { status: 'queued' })
    if (status !== 'queued') {
      await repo.transitionAgentRun(runId, { status: 'running', internalSessionId: `internal-${runId}` })
      if (status === 'completed') {
        await repo.transitionAgentRun(runId, {
          status: 'completed',
          result: {
            summary: '完成',
            conclusions: [],
            artifactPaths: [],
            unmetCriteria: [],
            boundaryViolations: [],
          },
        })
      } else if (status === 'failed' || status === 'interrupted') {
        await repo.transitionAgentRun(runId, { status: 'failed', failureMessage: '测试收尾' })
      }
    }
  }
  return (await repo.getAgentRun(runId))!
}

/** 同 graph 造多个 run(依赖必须同链:首 run 生成 graphId,后续复用)。 */
async function seedGraph(runs: ReadonlyArray<{ runId: string } & SeedOptions>): Promise<void> {
  let graphId: string | undefined
  for (const item of runs) {
    await seedRun(item.runId, { ...item, ...(graphId !== undefined ? { graphId } : {}) })
    graphId ??= (await repo.getAgentRun(item.runId))?.graphId
  }
}

describe('AgentRunScheduler(PLAN §6.2/§9.6)', () => {
  it('并发上限:槽空位逐个启动,第 4 条排队记 concurrency-limit;终态释放后补位', async () => {
    const scheduler = makeScheduler()
    await seedRun('run-0000000000000001', { status: 'running', createdAt: 1 })
    await seedRun('run-0000000000000002', { status: 'running', createdAt: 2 })
    await seedRun('run-0000000000000003', { status: 'queued', createdAt: 3 })
    await seedRun('run-0000000000000004', { status: 'queued', createdAt: 4 })
    await seedRun('run-0000000000000005', { status: 'queued', createdAt: 5 })

    await scheduler.tick()

    // 2 running + 1 个槽空位:run-3 启动;run-4/5 排队
    expect(tryStartCalls).toEqual(['run-0000000000000003'])
    expect((await repo.getAgentRun('run-0000000000000003'))?.status).toBe('running')
    expect((await repo.getAgentRun('run-0000000000000004'))?.queueReason).toBe('concurrency-limit')
    expect((await repo.getAgentRun('run-0000000000000005'))?.queueReason).toBe('concurrency-limit')

    // 释放一个槽(终态)再 tick:最早排队的补位
    await repo.transitionAgentRun('run-0000000000000001', {
      status: 'failed',
      failureMessage: '腾槽',
    })
    await scheduler.tick()
    expect(tryStartCalls).toEqual(['run-0000000000000003', 'run-0000000000000004'])
    expect((await repo.getAgentRun('run-0000000000000004'))?.status).toBe('running')
  })

  it('依赖未完成:下游保持 queued 并记 dependency,不尝试启动', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'running', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
    ])
    await scheduler.tick()
    expect(tryStartCalls).toEqual([])
    expect((await repo.getAgentRun('run-0000000000000002'))?.queueReason).toBe('dependency')
  })

  it('依赖上游还在排队(awaiting/queued):下游同样等待', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'awaiting-approval', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
    ])
    await scheduler.tick()
    expect(tryStartCalls).toEqual([])
    expect((await repo.getAgentRun('run-0000000000000002'))?.queueReason).toBe('dependency')
  })

  it('依赖失败级联:上游终态但非 completed,下游自动收 failed 并通知', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'failed', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
    ])
    await scheduler.tick()
    expect(tryStartCalls).toEqual([])
    const cascadedRun = await repo.getAgentRun('run-0000000000000002')
    expect(cascadedRun?.status).toBe('failed')
    expect(cascadedRun?.failureMessage).toContain('上游派活')
    expect(cascaded).toEqual(['run-0000000000000002'])
  })

  it('依赖链级联传播:A failed → B 级联 → C(依赖 B)同轮也级联', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'failed', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
      { runId: 'run-0000000000000003', status: 'queued', deps: ['run-0000000000000002'], createdAt: 3 },
    ])
    await scheduler.tick()
    expect(cascaded.sort()).toEqual(['run-0000000000000002', 'run-0000000000000003'])
  })

  it('依赖全 completed:下游可启动', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'completed', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
    ])
    await scheduler.tick()
    expect(tryStartCalls).toEqual(['run-0000000000000002'])
    expect((await repo.getAgentRun('run-0000000000000002'))?.status).toBe('running')
  })

  it('公平排序:多 queued 按 (createdAt, runId) 稳定挑选', async () => {
    const scheduler = makeScheduler()
    // 同 createdAt 的两个 queued:runId 字典序决定先后
    await seedRun('run-000000000000000b', { status: 'queued', createdAt: 100 })
    await seedRun('run-000000000000000a', { status: 'queued', createdAt: 100 })
    await seedRun('run-0000000000000009', { status: 'queued', createdAt: 50 })
    await scheduler.tick()
    expect(tryStartCalls).toEqual([
      'run-0000000000000009',
      'run-000000000000000a',
      'run-000000000000000b',
    ])
  })

  it('lease-conflict 不占并发槽:调度器继续尝试下一条 queued', async () => {
    const scheduler = makeScheduler()
    await seedRun('run-0000000000000001', { status: 'running', createdAt: 1 })
    await seedRun('run-0000000000000002', { status: 'running', createdAt: 2 })
    await seedRun('run-0000000000000003', { status: 'queued', createdAt: 3 })
    await seedRun('run-0000000000000004', { status: 'queued', createdAt: 4 })
    tryStartImpl = async (run) => {
      // run-3 模拟根互斥冲突(租约原语已留 queued),其余真启动
      if (run.runId === 'run-0000000000000003') {
        tryStartCalls.push(run.runId)
        return 'lease-conflict'
      }
      tryStartCalls.push(run.runId)
      await repo.transitionAgentRun(run.runId, {
        status: 'running',
        internalSessionId: `internal-${run.runId}`,
      })
      return 'started'
    }
    await scheduler.tick()
    // run-3 冲突不占槽,run-4 仍被尝试启动
    expect(tryStartCalls).toEqual(['run-0000000000000003', 'run-0000000000000004'])
    expect((await repo.getAgentRun('run-0000000000000004'))?.status).toBe('running')
    expect((await repo.getAgentRun('run-0000000000000003'))?.status).toBe('queued')
  })

  it('并发 tick 自动合并:同一 run 只被启动一次', async () => {
    const scheduler = makeScheduler()
    await seedRun('run-0000000000000001', { status: 'queued', createdAt: 1 })
    await Promise.all([scheduler.tick(), scheduler.tick()])
    expect(tryStartCalls).toEqual(['run-0000000000000001'])
  })

  it('dispose 后 tick 不再启动任何 run', async () => {
    const scheduler = makeScheduler()
    await seedRun('run-0000000000000001', { status: 'queued', createdAt: 1 })
    scheduler.dispose()
    await scheduler.tick()
    expect(tryStartCalls).toEqual([])
  })

  it('tick 永不 reject:DB 异常只记日志不冒泡到 void 调用点(backend 专审整改)', async () => {
    const scheduler = makeScheduler()
    await seedRun('run-0000000000000001', { status: 'queued', createdAt: 1 })
    const spy = vi
      .spyOn(repo, 'transitionAgentRun')
      .mockRejectedValueOnce(new Error('模拟 DB 故障'))
    await expect(scheduler.tick()).resolves.toBeUndefined()
    spy.mockRestore()
    // 故障不炸、run 未被误收终态;下一轮 tick 正常启动
    expect((await repo.getAgentRun('run-0000000000000001'))?.status).toBe('queued')
    await scheduler.tick()
    expect(tryStartCalls).toEqual(['run-0000000000000001', 'run-0000000000000001'])
    expect((await repo.getAgentRun('run-0000000000000001'))?.status).toBe('running')
  })

  it('级联竞态兜底:级联转换撞 AgentRunTransitionError 时跳过不抛错(backend 专审整改)', async () => {
    const scheduler = makeScheduler()
    await seedGraph([
      { runId: 'run-0000000000000001', status: 'failed', createdAt: 1 },
      { runId: 'run-0000000000000002', status: 'queued', deps: ['run-0000000000000001'], createdAt: 2 },
    ])
    // 模拟 fresh 读之后、级联事务之前被并发方(interrupt)收终态:转换抛非法转换错误
    const original = repo.transitionAgentRun.bind(repo)
    const spy = vi.spyOn(repo, 'transitionAgentRun').mockImplementation(async (runId, transition) => {
      if (transition.status === 'failed') {
        // 先让"并发方"落 interrupted,再让本次级联转换撞状态机
        await original(runId, {
          status: 'interrupted',
          failureMessage: '并发打断',
          interruptSource: 'user',
        })
        return original(runId, transition)
      }
      return original(runId, transition)
    })
    await expect(scheduler.tick()).resolves.toBeUndefined()
    spy.mockRestore()
    expect(cascaded).toEqual([])
    expect((await repo.getAgentRun('run-0000000000000002'))?.status).toBe('interrupted')
  })
})

describe('调度器批 repository 原语上限(PLAN §6.2)', () => {
  it('单条 run 最多 8 个依赖', async () => {
    const graph = await seedRun('run-0000000000000001')
    const deps = Array.from({ length: 8 }, (_, i) => `run-000000000000000${i + 2}`)
    for (const dep of deps) {
      await seedRun(dep, { graphId: graph.graphId })
    }
    // 8 个依赖合法
    await expect(
      seedRun('run-0000000000000010', { deps, graphId: graph.graphId }),
    ).resolves.toBeTruthy()
    // 第 9 个拒绝
    const nine = [...deps, 'run-0000000000000010']
    await expect(
      repo.createAgentRun({
        runId: 'run-0000000000000011',
        managerSessionId: 'manager-session',
        targetRoleId: 'agent-a1b2c3d4e5f6',
        targetRoleNameSnapshot: '小编',
        envelope,
        graphId: graph.graphId,
        dependsOnRunIds: nine,
      }),
    ).rejects.toThrow('最多依赖 8 个')
  })

  it('单条协作链最多 64 个节点:第 64 个可入,第 65 个拒绝', async () => {
    const first = await seedRun('run-0000000000000001')
    for (let i = 2; i <= 64; i++) {
      await seedRun(`run-00000000000000${String(i).padStart(2, '0')}`, { graphId: first.graphId })
    }
    // 已 64 个:第 65 个被拒
    await expect(
      repo.createAgentRun({
        runId: 'run-0000000000000065',
        managerSessionId: 'manager-session',
        targetRoleId: 'agent-a1b2c3d4e5f6',
        targetRoleNameSnapshot: '小编',
        envelope,
        graphId: first.graphId,
      }),
    ).rejects.toThrow('64 个节点')
  })

  it('queueReason 只能记在 queued 态上', async () => {
    await seedRun('run-0000000000000001', { status: 'running' })
    await expect(
      repo.setAgentRunQueueReason('run-0000000000000001', 'dependency'),
    ).rejects.toThrow('排队中的派活')
  })

  it('listQueuedAgentRuns 按 (createdAt, runId) 稳定排序', async () => {
    await seedRun('run-000000000000000b', { status: 'queued', createdAt: 100 })
    await seedRun('run-000000000000000a', { status: 'queued', createdAt: 100 })
    await seedRun('run-0000000000000009', { status: 'queued', createdAt: 50 })
    await seedRun('run-0000000000000008', { status: 'running', createdAt: 1 })
    const queued = await repo.listQueuedAgentRuns()
    expect(queued.map((run) => run.runId)).toEqual([
      'run-0000000000000009',
      'run-000000000000000a',
      'run-000000000000000b',
    ])
  })
})
