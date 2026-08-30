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
 *
 * 0.5.0 第三批(A-28,PLAN §6.6):四场景断言迁入协作链常驻面板——
 * 纵向顺序/交棒连接行/并行同层/同 run tab 追加计数/interrupted 节点态;
 * 另验六条:收起展开三态、派活卡入口 pin 对应节点、720 窄窗(main-pane ≈720)可用、
 * 不再切整页、普通角色会话无面板、切 manager 会话不串链。
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
  graphId?: string,
): Promise<void> {
  const repo = new RoleRepository(join(seed.userDataDir, 'data', 'roles.sqlite'))
  await repo.createAgentRun({
    runId,
    managerSessionId: seed.managerSessionId,
    targetRoleId,
    targetRoleNameSnapshot: targetRoleName,
    ...(graphId !== undefined ? { graphId } : {}),
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

/** 直写一条 completed run(交棒上游;internal 会话用占位串,面板 tab 里会如实显示「过程会话缺失」)。 */
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
  scenario?: CollabScenario,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAWEIGE_USER_DATA: seed.userDataDir,
      ...(scenario !== undefined ? { DAWEIGE_E2E_SCENARIO: scenario } : {}),
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

    // ---- A-28 面板:活跃链自动展开成面板态;纵向顺序 账房→小编;handoff 连接行 ----
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-panel/, { timeout: 10000 })
    await expect(panel.locator('.collab-flow-node')).toHaveCount(2, { timeout: 10000 })
    const flowNames = await panel.locator('.collab-flow-node .collab-flow-name').allTextContents()
    expect(flowNames).toEqual(['账房', '小编'])
    // 交棒标识:getGraph 缓存补回 handoff 边后,连接行出「来自:账房(交棒)」
    await expect(panel.locator('.collab-flow-upstream.is-handoff')).toHaveText('来自:账房(交棒)', {
      timeout: 10000,
    })
    // 顶部汇总:2 节点 · 进行中 1 · 完成 1
    await expect(panel.locator('.collab-aggregate')).toContainText('2 节点')
    await expect(panel.locator('.collab-aggregate')).toContainText('进行中 1')
    await expect(panel.locator('.collab-aggregate')).toContainText('完成 1')

    // ---- A-28 收编:派活卡「查看完整过程」→ 面板详情态并 pin 这张卡的 tab,不再切整页 ----
    await card.getByRole('button', { name: '查看完整过程' }).click()
    await expect(panel).toHaveClass(/is-detail/)
    const tabs = panel.locator('.collab-tab')
    await expect(tabs).toHaveCount(2)
    // pin 的是这张卡的 run:小编 tab 选中,过程区是它的完整输出(还在干活)
    await expect(panel.locator('.collab-tab.is-active')).toContainText('小编')
    await expect(panel.locator('.run-process-pane')).toContainText('小编正在干活', { timeout: 10000 })
    // 详情态左栏流程仍在,可点节点切 tab
    await expect(panel.locator('.collab-flow-pane .collab-flow-node')).toHaveCount(2)
    // 不再切整页:旧整页详情不存在,对话区没离开(输入框还在)
    await expect(win.locator('.run-detail-pane')).toHaveCount(0)
    await expect(textarea).toBeVisible()
    // tab 切换:点账房 tab(占位 internal 会话,如实显示缺失)
    await tabs.first().click()
    await expect(panel.locator('.collab-tab.is-active')).toContainText('账房')
    await expect(panel.locator('.run-process-pane')).toContainText('过程会话缺失', { timeout: 10000 })
    // 收起详情回面板态(链还活跃)
    await panel.locator('.collab-detail-close').click()
    await expect(panel).toHaveClass(/is-panel/)

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
  // 三条 run 同 graph(无依赖边 → 面板里是同层并行的三个节点)
  const graphId = 'graph-aaaabbbbccccdddd'
  await seedAwaitingRun(seed, 'run-aaaaaaaaaaaaaaaa', ZHANGFANG_ROLE, '账房', seed.wsA, '汇总账房数据', graphId)
  await seedAwaitingRun(seed, 'run-bbbbbbbbbbbbbbbb', XIAOBIAN_ROLE, '小编', seed.wsB, '写小编稿件', graphId)
  await seedAwaitingRun(seed, 'run-cccccccccccccccc', ZHANGFANG_ROLE, '账房', seed.wsA, '复核账房数据', graphId)
  const { app, win } = await launchCollab(seed, 'collab-parallel')
  try {
    // 三张确认卡(resume 夹具并发接管);依次批准
    for (const task of ['汇总账房数据', '写小编稿件', '复核账房数据']) {
      const card = win.locator('.delegation-card', { hasText: task })
      await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
      await card.getByRole('button', { name: '同意派出' }).click()
    }

    // ---- A-28 面板:同层并行三节点,两条干活中、一条排队中,互不挤层 ----
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-panel/, { timeout: 10000 })
    const parallelLayer = panel.locator('.collab-flow-layer.is-parallel')
    await expect(parallelLayer.locator('.collab-flow-node')).toHaveCount(3, { timeout: 10000 })
    await expect(parallelLayer.locator('.collab-flow-parallel-tag')).toHaveText('并行')
    await expect(panel.locator('.collab-flow-state', { hasText: '干活中' })).toHaveCount(2)
    await expect(panel.locator('.collab-flow-state', { hasText: '排队中' })).toHaveCount(1)
    // 顶部汇总:3 节点 · 进行中 3(queued 也算进行中口径,与主进程 aggregate 一致)
    await expect(panel.locator('.collab-aggregate')).toContainText('3 节点')

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

    // ---- A-28 面板:详情态开在账房 tab,再发补充——同 run tab 过程原位更新 ----
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-panel/, { timeout: 10000 })
    await panel.getByRole('button', { name: '查看详情' }).click()
    await expect(panel).toHaveClass(/is-detail/)
    await expect(panel.locator('.collab-tab.is-active')).toContainText('账房')
    await expect(panel.locator('.run-process-pane')).toContainText('账房正在干活', { timeout: 10000 })

    await seedFakeKey(win)
    // 用户在小柊会话补一句 → faux 调 followup_task → 工具送达
    const textarea = win.locator('textarea')
    await textarea.fill('补充:顺便核对汇总表')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('补充要求已经送达', { timeout: 15000 })

    // 面板同 run tab 原位更新:过程区 meta 与流程行都出「追加 1 次」(不建新 run、不切 tab)
    await expect(panel.locator('.run-process-meta')).toContainText('追加 1 次', { timeout: 10000 })
    await expect(panel.locator('.collab-flow-pane .collab-flow-followup')).toHaveText('追加 1 次')

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

    // ---- A-28 面板:干活中挂在面板态流程里 ----
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-panel/, { timeout: 10000 })
    await expect(panel.locator('.collab-flow-state')).toHaveText('干活中')

    // 行内两步确认打断
    await card.getByRole('button', { name: '打断' }).click()
    await card.getByRole('button', { name: '确定打断' }).click()
    await expect(card).toContainText('已中断', { timeout: 10000 })

    // ---- A-28 面板:全终态自动收小窗但面板不消失;点开流程看到 interrupted 节点态 ----
    await expect(panel).toHaveClass(/is-mini/, { timeout: 10000 })
    await expect(panel.locator('.collab-mini-line')).toHaveText('账房 · 1 节点')
    await panel.locator('.collab-mini').click()
    await expect(panel).toHaveClass(/is-panel/)
    await expect(panel.locator('.collab-flow-state')).toHaveText('已中断')

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

test('A-28 三态:面板→小窗→面板→详情往返;960 窗(main-pane≈720)详情抽屉可用不溢出', async () => {
  const seed = await seedCollabWorkspace()
  const runId = 'run-1111111111111111'
  await seedAwaitingRun(seed, runId, ZHANGFANG_ROLE, '账房', seed.wsA, '汇总账房数据')
  const { app, win } = await launchCollab(seed, 'collab-followup', {
    DAWEIGE_E2E_RUN_ID: runId,
  })
  try {
    const card = win.locator('.delegation-card', { hasText: '汇总账房数据' })
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '同意派出' }).click()

    const panel = win.locator('.collab-panel')
    // 活跃自动展开(面板态)
    await expect(panel).toHaveClass(/is-panel/, { timeout: 10000 })

    // 面板 → 小窗:摘要一行;小窗 → 面板:整卡点回
    await panel.getByRole('button', { name: '收起' }).click()
    await expect(panel).toHaveClass(/is-mini/)
    await expect(panel.locator('.collab-mini-line')).toHaveText('账房 · 1 节点')
    await panel.locator('.collab-mini').click()
    await expect(panel).toHaveClass(/is-panel/)

    // 面板 → 详情:tab + 过程区就位
    await panel.getByRole('button', { name: '查看详情' }).click()
    await expect(panel).toHaveClass(/is-detail/)
    await expect(panel.locator('.collab-tab')).toHaveCount(1)
    await expect(panel.locator('.run-process-pane')).toContainText('账房正在干活', { timeout: 10000 })
    // 宽屏:流程左栏常驻,抽屉开关不出场
    await expect(panel.locator('.collab-flow-pane')).toBeVisible()
    await expect(panel.locator('.collab-flow-drawer-toggle')).toBeHidden()

    // ---- 720 窄窗(窗口最小 960,侧栏后 main-pane≈720):详情铺满可用宽度 ----
    const browserWindow = await app.browserWindow(win)
    await browserWindow.evaluate((w) => w.setSize(960, 640))
    await win.waitForTimeout(400) // 布局沉降
    // 流程栏收成抽屉:左栏隐藏、抽屉开关出场
    await expect(panel.locator('.collab-flow-pane')).toBeHidden()
    await expect(panel.locator('.collab-flow-drawer-toggle')).toBeVisible()
    // 点开抽屉:流程可点;再点收回
    await panel.locator('.collab-flow-drawer-toggle').click()
    await expect(panel.locator('.collab-flow-pane')).toBeVisible()
    await panel.locator('.collab-flow-drawer-toggle').click()
    await expect(panel.locator('.collab-flow-pane')).toBeHidden()
    // tabs 与过程区仍可用;main-pane 无横向溢出
    await expect(panel.locator('.collab-tab.is-active')).toContainText('账房')
    await expect(panel.locator('.run-process-pane')).toBeVisible()
    const overflow = await win.evaluate(() => {
      // tsconfig.node 无 DOM lib:结构化类型拿 document(回调实际在渲染进程里跑)
      const doc = (globalThis as unknown as {
        document: {
          querySelector(selector: string): { scrollWidth: number; clientWidth: number } | null
        }
      }).document
      const el = doc.querySelector('.main-pane')
      return el === null ? null : el.scrollWidth - el.clientWidth
    })
    expect(overflow).not.toBeNull()
    expect(overflow!).toBeLessThanOrEqual(1)

    // 详情 → 面板(头栏收起),链仍活跃 → 面板态
    await panel.locator('.collab-detail-close').click()
    await expect(panel).toHaveClass(/is-panel/)
  } finally {
    await app.close()
  }
})

test('A-28 会话边界:普通角色会话无面板;切走再切回小柊不串链', async () => {
  const seed = await seedCollabWorkspace()
  // 一条全终态链(空闲小窗态)+ 账房的普通用户会话(面板不该在那边出现)
  await seedCompletedRun(seed, 'run-1111111111111111', seed.wsA)
  const sessionRepo = new SessionRepository(join(seed.userDataDir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  const workerSession = await sessionRepo.create({
    cwd: seed.wsA,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
  })
  const workerMeta = await workerSession.getMetadata()
  await sessionRepo.close()
  const bindRepo = new RoleRepository(join(seed.userDataDir, 'data', 'roles.sqlite'))
  await bindRepo.bindSession({
    sessionId: workerMeta.id,
    roleId: ZHANGFANG_ROLE,
    workspacePathSnapshot: seed.wsA,
    archivedAt: null,
    visibility: 'user',
    source: 'created',
  })
  await bindRepo.drainAndClose()

  const { app, win } = await launchCollab(seed)
  try {
    // 默认入口=小柊会话:全终态 → 小窗态,摘要一行
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-mini/, { timeout: 10000 })
    await expect(panel.locator('.collab-mini-line')).toHaveText('账房 · 1 节点')
    // 空闲链的小窗也点得开(手动展开档):流程里看到已完成节点
    await panel.locator('.collab-mini').click()
    await expect(panel).toHaveClass(/is-panel/)
    await expect(panel.locator('.collab-flow-state')).toHaveText('已完成')

    // 切到账房的普通会话:面板整体不渲染
    const workerCard = win.locator('.role-card', { hasText: '账房' })
    await workerCard.locator('.role-card-head').click()
    await workerCard.locator('.session-item').first().click()
    await win.waitForTimeout(600)
    await expect(win.locator('.collab-panel')).toHaveCount(0)

    // 切回小柊:面板回来且仍是那条链(不串链;切会话已清手动档 → 回到空闲小窗)
    const managerCard = win.locator('.manager-card')
    await managerCard.locator('.role-card-head').click()
    await managerCard.locator('.session-item').first().click()
    await expect(win.locator('.collab-panel')).toHaveClass(/is-mini/, { timeout: 10000 })
    await expect(win.locator('.collab-mini-line')).toHaveText('账房 · 1 节点')
  } finally {
    await app.close()
  }
})
