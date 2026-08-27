import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'
import { RoleRepository, type AgentRunRow } from '../../src/main/roles/role-repository'
import { canonicalWorkspaceKey } from '../../src/main/roles/role-files'

/**
 * 0.4.0 D 协作链 E2E(PLAN §9.9-6~9):pipeline/parallel/followup/interrupt 四场景。
 * 结构:真实 Electron+真实调度/审批/事件流/DB;模型 faux(manager 会话工具调用)或
 * scripted 挂起 runner(child run 停在 running 态供断言);直写库 seed+resume 夹具。
 */

const ZHANGFANG_ROLE = 'agent-a1b2c3d4e5f6'
const XIAOBIAN_ROLE = 'agent-b2c3d4e5f6a7'

interface CollabSeed {
  readonly userDataDir: string
  readonly wsA: string
  readonly wsB: string
  readonly managerSessionId: string
}

/** 双 worker(账房/小编)各占互不重叠的根 + manager 入口(真实 pi 会话)。 */
async function seedCollabWorkspace(): Promise<CollabSeed> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'collab-e2e-'))
  const wsA = join(userDataDir, '账房数据')
  const wsB = join(userDataDir, '小编稿件')
  await mkdir(wsA, { recursive: true })
  await mkdir(wsB, { recursive: true })
  await writeFile(join(wsA, 'summary.md'), '门店销售总计 20370')
  // 角色家目录父目录:启动"家目录缺失重建"走 staging rename,父目录不存在会 ENOENT
  await mkdir(join(userDataDir, 'daweige', 'agents'), { recursive: true })
  await mkdir(join(userDataDir, 'daweige', 'system'), { recursive: true })
  const sessionRepo = new SessionRepository(join(userDataDir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  const mgrSession = await sessionRepo.create({
    cwd: join(userDataDir, 'system-manager-workspace'),
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
  })
  const mgrMeta = await mgrSession.getMetadata()
  await sessionRepo.close()
  const repo = new RoleRepository(join(userDataDir, 'data', 'roles.sqlite'))
  await repo.insertRole({
    role: {
      id: 'sys-xiaozhen',
      kind: 'manager',
      displayName: '小柊',
      templateId: 'manager-built-in',
      homeRelPath: 'daweige/system/sys-xiaozhen',
      guardrailsRelPath: 'manager-prompt.md',
      createdAt: 1,
      updatedAt: 1,
    },
    mounts: [],
    bindings: [{
      sessionId: mgrMeta.id,
      workspacePathSnapshot: userDataDir,
      archivedAt: null,
      visibility: 'user',
      source: 'created',
      boundAt: 1,
    }],
  })
  await repo.insertRole({
    role: {
      id: ZHANGFANG_ROLE,
      kind: 'worker',
      displayName: '账房',
      templateId: 'accountant',
      homeRelPath: `daweige/agents/${ZHANGFANG_ROLE}`,
      guardrailsRelPath: 'guardrails.md',
      createdAt: 2,
      updatedAt: 2,
    },
    mounts: [{
      workspacePath: wsA,
      canonicalKey: await canonicalWorkspaceKey(wsA),
      ordinal: 0,
      isPrimary: true,
      availability: 'available',
    }],
  })
  await repo.insertRole({
    role: {
      id: XIAOBIAN_ROLE,
      kind: 'worker',
      displayName: '小编',
      templateId: 'writer',
      homeRelPath: `daweige/agents/${XIAOBIAN_ROLE}`,
      guardrailsRelPath: 'guardrails.md',
      createdAt: 3,
      updatedAt: 3,
    },
    mounts: [{
      workspacePath: wsB,
      canonicalKey: await canonicalWorkspaceKey(wsB),
      ordinal: 0,
      isPrimary: true,
      availability: 'available',
    }],
  })
  await repo.drainAndClose()
  return { userDataDir, wsA, wsB, managerSessionId: mgrMeta.id }
}

async function seedAwaitingRun(
  seed: CollabSeed,
  runId: string,
  targetRoleId: string,
  targetRoleName: string,
  workspace: string,
  taskBrief: string,
): Promise<void> {
  const repo = new RoleRepository(join(seed.userDataDir, 'data', 'roles.sqlite'))
  await repo.createAgentRun({
    runId,
    managerSessionId: seed.managerSessionId,
    targetRoleId,
    targetRoleNameSnapshot: targetRoleName,
    envelope: {
      userRequest: taskBrief,
      managerConclusions: ['协作链 E2E 预置'],
      taskBrief,
      acceptanceCriteria: ['按简报完成'],
      allowedWorkspacePaths: [workspace],
    },
  })
  await repo.drainAndClose()
}

/** 直写一条 completed run(交棒上游;internal 会话用占位串,不进详情页即无影响)。 */
async function seedCompletedRun(
  seed: CollabSeed,
  runId: string,
  workspace: string,
): Promise<void> {
  const repo = new RoleRepository(join(seed.userDataDir, 'data', 'roles.sqlite'))
  await repo.createAgentRun({
    runId,
    managerSessionId: seed.managerSessionId,
    targetRoleId: ZHANGFANG_ROLE,
    targetRoleNameSnapshot: '账房',
    envelope: {
      userRequest: '汇总门店销售数据',
      managerConclusions: [],
      taskBrief: '按门店汇总销售明细',
      acceptanceCriteria: ['总计数字准确'],
      allowedWorkspacePaths: [workspace],
    },
  })
  await repo.transitionAgentRun(runId, { status: 'queued' })
  await repo.transitionAgentRun(runId, { status: 'running', internalSessionId: `e2e-internal-${runId}` })
  await repo.transitionAgentRun(runId, {
    status: 'completed',
    result: {
      summary: '账目已汇总',
      conclusions: ['门店销售总计 20370'],
      artifactPaths: [join(workspace, 'summary.md')],
      unmetCriteria: [],
      boundaryViolations: [],
    },
  })
  await repo.drainAndClose()
}

type CollabScenario = 'collab-pipeline' | 'collab-parallel' | 'collab-followup' | 'collab-interrupt'

async function launchCollab(
  seed: CollabSeed,
  scenario: CollabScenario,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAWEIGE_USER_DATA: seed.userDataDir,
      DAWEIGE_E2E_SCENARIO: scenario,
      ...extraEnv,
    },
  })
  app.process().stdout?.on('data', (d: Buffer) => console.log('[MAIN]', d.toString().trim()))
  app.process().stderr?.on('data', (d: Buffer) => console.log('[MAIN-ERR]', d.toString().trim()))
  const win = await app.firstWindow()
  await win.waitForTimeout(2500) // 迁移+种子化+resume 夹具
  return { app, win }
}

async function openRuns(
  seed: CollabSeed,
): Promise<RoleRepository> {
  return new RoleRepository(join(seed.userDataDir, 'data', 'roles.sqlite'))
}

/** E2E 里走真实设置页存一个假 key(faux 模型不消费;只为过发送前的配置检查)。 */
async function seedFakeKey(win: Page): Promise<void> {
  await win.getByRole('button', { name: '设置' }).click()
  const keyInput = win.locator('#api-key-input')
  await expect(keyInput).toBeVisible()
  await keyInput.fill('sk-e2e-fake-key')
  await win.getByRole('button', { name: '保存 key' }).click()
  await win.getByRole('button', { name: /回到聊天/ }).click()
  await win.waitForTimeout(300)
}

test('collab-pipeline:账房定论经小柊交棒小编,handoff 边/信封无过程/新卡照弹', async () => {
  const seed = await seedCollabWorkspace()
  const sourceRunId = 'run-1111111111111111'
  await seedCompletedRun(seed, sourceRunId, seed.wsA)
  const { app, win } = await launchCollab(seed, 'collab-pipeline', {
    DAWEIGE_E2E_RUN_ID: sourceRunId,
    DAWEIGE_E2E_TARGET_ROLE: XIAOBIAN_ROLE,
    DAWEIGE_E2E_WS_B: seed.wsB,
  })
  try {
    await seedFakeKey(win)
    // 默认入口=小柊会话;发指令 → faux 调 send_message → 下游确认卡弹出
    const textarea = win.locator('textarea')
    await textarea.fill('账房汇总完了,让小编接手写通报')
    await win.getByRole('button', { name: '发送' }).click()
    const card = win.locator('.delegation-card', { hasText: '门店通报' })
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '同意派出' }).click()

    // 小编 run 启动(hang runner 停在 running);模型收尾文本落地
    await expect(win.locator('.msg-assistant').last()).toContainText('已交棒', { timeout: 15000 })

    // DB 侧:handoff 边+依赖+同 graph;下游信封只有定论,无 thinking/transcript
    const repo = await openRuns(seed)
    try {
      const runs = await repo.listAgentRuns(seed.managerSessionId)
      const downstream = runs.find((run) => run.runId !== sourceRunId)!
      expect(downstream.targetRoleNameSnapshot).toBe('小编')
      expect(downstream.status).toBe('running')
      expect(downstream.parentRunId).toBe(sourceRunId)
      expect(downstream.dependsOnRunIds).toEqual([sourceRunId])
      const conclusions = downstream.envelope.managerConclusions.join('\n')
      expect(conclusions).toContain('「账房」的定论:门店销售总计 20370')
      expect(conclusions).toContain('summary.md')
      expect(conclusions).not.toContain('thinking')
      const { edges } = await repo.getAgentRunGraph(downstream.graphId)
      expect(edges).toContainEqual({ from: sourceRunId, to: downstream.runId, kind: 'handoff' })
    } finally {
      await repo.drainAndClose()
    }
  } finally {
    await app.close()
  }
})

test('collab-parallel:不同根双 run 同时 running,同根第三条排队 workspace-lock', async () => {
  const seed = await seedCollabWorkspace()
  await seedAwaitingRun(seed, 'run-aaaaaaaaaaaaaaaa', ZHANGFANG_ROLE, '账房', seed.wsA, '汇总账房数据')
  await seedAwaitingRun(seed, 'run-bbbbbbbbbbbbbbbb', XIAOBIAN_ROLE, '小编', seed.wsB, '写小编稿件')
  await seedAwaitingRun(seed, 'run-cccccccccccccccc', ZHANGFANG_ROLE, '账房', seed.wsA, '复核账房数据')
  const { app, win } = await launchCollab(seed, 'collab-parallel')
  try {
    // 三张确认卡(resume 夹具并发接管);依次批准
    for (const task of ['汇总账房数据', '写小编稿件', '复核账房数据']) {
      const card = win.locator('.delegation-card', { hasText: task })
      await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
      await card.getByRole('button', { name: '同意派出' }).click()
    }
    // 前两条(不同根)并行 running;第三条(同根 ws-a)被租约挡下排队
    await win.waitForTimeout(1500)
    const repo = await openRuns(seed)
    try {
      const runs = await repo.listAgentRuns(seed.managerSessionId)
      const running = runs.filter((run) => run.status === 'running')
      const queued = runs.filter((run) => run.status === 'queued')
      expect(running).toHaveLength(2)
      expect(queued).toHaveLength(1)
      expect(queued[0]!.runId).toBe('run-cccccccccccccccc')
      expect(queued[0]!.queueReason).toBe('workspace-lock')
      expect(running.map((run) => run.runId).sort()).toEqual(['run-aaaaaaaaaaaaaaaa', 'run-bbbbbbbbbbbbbbbb'])
    } finally {
      await repo.drainAndClose()
    }
  } finally {
    await app.close()
  }
})

test('collab-followup:running 中经小柊补一句,同 run 计数+1 且 input 留档', async () => {
  const seed = await seedCollabWorkspace()
  const runId = 'run-1111111111111111'
  await seedAwaitingRun(seed, runId, ZHANGFANG_ROLE, '账房', seed.wsA, '汇总账房数据')
  const { app, win } = await launchCollab(seed, 'collab-followup', {
    DAWEIGE_E2E_RUN_ID: runId,
  })
  try {
    // 批准预置 run → running(hang)
    const card = win.locator('.delegation-card', { hasText: '汇总账房数据' })
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '同意派出' }).click()
    await win.waitForTimeout(1000)

    await seedFakeKey(win)
    // 用户在小柊会话补一句 → faux 调 followup_task → 工具送达
    const textarea = win.locator('textarea')
    await textarea.fill('补充:顺便核对汇总表')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('补充要求已经送达', { timeout: 15000 })

    // DB:同 run(不建新 run),followup_count+1,input 留档
    const repo = await openRuns(seed)
    try {
      const runs = await repo.listAgentRuns(seed.managerSessionId)
      expect(runs).toHaveLength(1)
      const run = runs[0]!
      expect(run.status).toBe('running')
      expect(run.followupCount).toBe(1)
      const inputs = await repo.listUndeliveredAgentRunInputs(runId)
      const followups = inputs.filter((item) => item.kind === 'followup')
      expect(followups).toHaveLength(1)
      expect(JSON.stringify(followups[0]!.payload)).toContain('顺便把汇总表也核对一遍')
    } finally {
      await repo.drainAndClose()
    }
  } finally {
    await app.close()
  }
})

test('collab-interrupt:running 中行内确认打断,run 收 interrupted(user) 且租约释放', async () => {
  const seed = await seedCollabWorkspace()
  const runId = 'run-1111111111111111'
  await seedAwaitingRun(seed, runId, ZHANGFANG_ROLE, '账房', seed.wsA, '汇总账房数据')
  const { app, win } = await launchCollab(seed, 'collab-interrupt')
  try {
    // 批准 → running(hang)
    const card = win.locator('.delegation-card', { hasText: '汇总账房数据' })
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '同意派出' }).click()
    await expect(card.getByRole('button', { name: '打断' })).toBeVisible({ timeout: 10000 })

    // 行内两步确认打断
    await card.getByRole('button', { name: '打断' }).click()
    await card.getByRole('button', { name: '确定打断' }).click()
    await expect(card).toContainText('已中断', { timeout: 10000 })

    // DB:interrupted(user)+租约释放
    const repo = await openRuns(seed)
    try {
      const run = (await repo.listAgentRuns(seed.managerSessionId))[0] as AgentRunRow
      expect(run.status).toBe('interrupted')
      expect(run.interruptSource).toBe('user')
      expect(await repo.findLeaseConflicts([seed.wsA], 'run-none')).toEqual([])
    } finally {
      await repo.drainAndClose()
    }
  } finally {
    await app.close()
  }
})
