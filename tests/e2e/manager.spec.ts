import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'
import { RoleRepository } from '../../src/main/roles/role-repository'
import { canonicalWorkspaceKey } from '../../src/main/roles/role-files'

/**
 * 0.3.0 总管 E2E(A 层:不依赖模型回合)——真实 Electron+真实迁移+真实种子化。
 * manager 的模型决策仍依赖真实 key,由集成测试+用户真机验收;
 * 这里从预置 awaiting-approval run 开始,验证真实确认 UI、编排执行、完成卡和详情页。
 * 前 2 条共享一个 userData(测启动迁移/恢复);后 2 条 scripted 场景各用独立 userData
 * +自建角色 fixture(自驱动,消除测试间顺序依赖——0.2.0 E2E 同款教训)。
 */

let userData: string
let wsDir: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'manager-e2e-'))
  wsDir = await mkdtemp(join(tmpdir(), 'manager-e2e-ws-'))
  await mkdir(join(wsDir, '报表'), { recursive: true })
})

test.afterAll(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  await rm(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

/** scripted 场景专用:独立 userData + 直写库建 manager 入口与 worker 角色(自驱动)。 */
async function seedScenarioWorkspace(): Promise<{ userDataDir: string; workspace: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'manager-e2e-scene-'))
  const workspace = join(userDataDir, '报表')
  await mkdir(workspace, { recursive: true })
  // 角色家目录父目录:启动时"家目录缺失重建"走 staging rename,父目录不存在会 ENOENT
  await mkdir(join(userDataDir, 'daweige', 'agents'), { recursive: true })
  await mkdir(join(userDataDir, 'daweige', 'system'), { recursive: true })
  // manager 入口必须先有真实 pi 会话(否则启动种子化会另建入口,id 与 run 对不上)
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
      id: 'agent-a1b2c3d4e5f6',
      kind: 'worker',
      displayName: '账房',
      templateId: 'accountant',
      homeRelPath: 'daweige/agents/agent-a1b2c3d4e5f6',
      guardrailsRelPath: 'guardrails.md',
      createdAt: 2,
      updatedAt: 2,
    },
    mounts: [{
      workspacePath: workspace,
      canonicalKey: await canonicalWorkspaceKey(workspace),
      ordinal: 0,
      isPrimary: true,
      availability: 'available',
    }],
  })
  await repo.drainAndClose()
  return { userDataDir, workspace }
}

/** scripted 场景:在独立库中直写一条 awaiting-approval run(角色由 seedScenarioWorkspace 建好)。 */
async function seedAwaitingRun(
  userDataDir: string,
  workspace: string,
  runId: string,
  taskBrief: string,
): Promise<void> {
  const repo = new RoleRepository(join(userDataDir, 'data', 'roles.sqlite'))
  const roles = await repo.listRoleRows()
  const worker = roles.find((role) => role.kind === 'worker')
  const bindings = await repo.listBindingRows()
  const manager = bindings.find((binding) => binding.roleId === 'sys-xiaozhen')
  if (!worker || !manager) throw new Error('E2E 前置角色或小柊入口不存在')
  await repo.createAgentRun({
    runId,
    managerSessionId: manager.sessionId,
    targetRoleId: worker.id,
    targetRoleNameSnapshot: worker.displayName,
    envelope: {
      userRequest: taskBrief,
      managerConclusions: ['使用 scripted child 验证编排链'],
      taskBrief,
      acceptanceCriteria: ['出现完成结论'],
      allowedWorkspacePaths: [workspace],
    },
  })
  await repo.drainAndClose()
}

async function launchApp(
  userDataDir: string,
  scenario?: 'manager-happy' | 'manager-boundary',
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAWEIGE_USER_DATA: userDataDir,
      ...(scenario ? { DAWEIGE_E2E_SCENARIO: scenario } : {}),
    },
  })
  app.process().stdout?.on('data', (d: Buffer) => console.log('[MAIN]', d.toString().trim()))
  app.process().stderr?.on('data', (d: Buffer) => console.log('[MAIN-ERR]', d.toString().trim()))
  const win = await app.firstWindow()
  await win.waitForTimeout(2500) // 迁移+种子化+bootstrap
  return { app, win }
}

test('首启:小柊置顶卡片上墙,默认入口是小柊会话;老会话归 worker 不误归小柊', async () => {
  // fixture:一个老的无绑定 pi 会话(cwd=中文目录)→ 启动迁移应归 worker 角色
  const sessionRepo = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  await sessionRepo.create({ cwd: join(wsDir, '报表'), providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  await sessionRepo.close()

  const { app, win } = await launchApp(userData)
  try {
    // 小柊置顶特殊卡(manager-card),带"总管"小印
    const managerCard = win.locator('.manager-card')
    await expect(managerCard).toBeVisible()
    await expect(managerCard.locator('.manager-seal')).toHaveText('总管')

    // 默认入口:打开的是小柊的会话(欢迎语/角色名"小柊"出现),不是 worker 旧会话
    await win.waitForTimeout(500)
    const body = await win.textContent('body')
    expect(body).toContain('小柊')

    // 老会话归 worker:角色库中小柊只有一个 manager,报表目录生成 worker 角色
    const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
    const rows = await roleRepo.listRoleRows()
    const managers = rows.filter((r) => r.kind === 'manager')
    expect(managers).toHaveLength(1)
    expect(managers[0]!.id).toBe('sys-xiaozhen')
    // worker 角色持有老会话(迁移正确),且不在小柊名下
    const bindings = await roleRepo.listBindingRows()
    const managerBindings = bindings.filter((b) => b.roleId === 'sys-xiaozhen')
    expect(managerBindings.length).toBeGreaterThanOrEqual(1) // 种子入口会话
    const oldWorkerBindings = bindings.filter((b) => b.roleId !== 'sys-xiaozhen' && b.visibility === 'user')
    expect(oldWorkerBindings).toHaveLength(1) // 老会话归 worker
    await roleRepo.drainAndClose()
  } finally {
    await app.close()
  }
})

test('internal 会话不进用户可见列表;遗留 running 派活重启后标记中断且释放串行槽', async () => {
  // fixture:直写库——一条 internal binding 的 pi 会话 + 一条 running 态 agent_run
  const sessionRepo = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  const internal = await sessionRepo.create({ cwd: join(wsDir, '报表'), providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  const internalMeta = await internal.getMetadata()
  await sessionRepo.close()

  const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const rows = await roleRepo.listRoleRows()
  const worker = rows.find((r) => r.kind === 'worker')!
  await roleRepo.bindSession({
    sessionId: internalMeta.id,
    roleId: worker.id,
    workspacePathSnapshot: join(wsDir, '报表'),
    archivedAt: null,
    visibility: 'internal',
    source: 'created',
  })
  // 小柊入口会话作为 manager_session;遗留 running run 占串行槽
  const bindings = await roleRepo.listBindingRows()
  const managerSession = bindings.find((b) => b.roleId === 'sys-xiaozhen')!
  await roleRepo.createAgentRun({
    runId: 'run-e2e0000000000001',
    managerSessionId: managerSession.sessionId,
    targetRoleId: worker.id,
    targetRoleNameSnapshot: '报表',
    envelope: {
      userRequest: '汇总报表',
      managerConclusions: [],
      taskBrief: '汇总',
      acceptanceCriteria: ['有总额'],
      allowedWorkspacePaths: [join(wsDir, '报表')],
    },
  })
  await roleRepo.transitionAgentRun('run-e2e0000000000001', { status: 'queued' })
  await roleRepo.transitionAgentRun('run-e2e0000000000001', { status: 'running', internalSessionId: internalMeta.id })
  await roleRepo.drainAndClose()

  const { app, win } = await launchApp(userData)
  try {
    // internal 会话不进侧栏:小柊卡下只有入口会话,worker 卡下没有 internal 会话
    const sidebarSessions = await win.locator('.session-item').allTextContents()
    const internalVisible = sidebarSessions.some((t) => t.includes(internalMeta.id))
    expect(internalVisible).toBe(false)

    // 重启恢复:遗留 running 收成 interrupted,释放串行槽
    const repo2 = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
    const run = await repo2.getAgentRun('run-e2e0000000000001')
    expect(run?.status).toBe('interrupted')
    expect(run?.failureMessage).toContain('没有自动继续')
    // 串行槽已释放:可再建新 run(非终态占槽约束已解除)
    await expect(
      repo2.createAgentRun({
        runId: 'run-e2e0000000000002',
        managerSessionId: managerSession.sessionId,
        targetRoleId: worker.id,
        targetRoleNameSnapshot: '报表',
        envelope: {
          userRequest: '再次汇总',
          managerConclusions: [],
          taskBrief: '再汇总',
          acceptanceCriteria: ['有总额'],
          allowedWorkspacePaths: [join(wsDir, '报表')],
        },
      }),
    ).resolves.toBeTruthy()
    await repo2.transitionAgentRun('run-e2e0000000000002', { status: 'rejected' })
    await repo2.drainAndClose()
  } finally {
    await app.close()
  }
})

test('派活确认→执行→完成卡→完整过程详情', async () => {
  const task = 'E2E scripted 汇总任务'
  const scene = await seedScenarioWorkspace()
  await seedAwaitingRun(scene.userDataDir, scene.workspace, 'run-e2ea1b2c3d4e5f60', task)
  const { app, win } = await launchApp(scene.userDataDir, 'manager-happy')
  try {
    const card = win.locator('.delegation-card', { hasText: task })
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible()
    await card.getByRole('button', { name: '同意派出' }).click()

    await expect(card).toContainText('干完了', { timeout: 30_000 })
    await expect(card).toContainText('轮次 1 · 总 token 200')
    await expect(card).toContainText('已按任务简报完成处理')

    // A-25(⑦审补):展开区横条图渲染非零段 + hover 出完整数值 tooltip(视觉验证抓过缺 :hover 的回归)
    await card.getByRole('button', { name: '展开细节' }).click()
    const bar = card.locator('.token-segment-bar')
    await expect(bar).toBeVisible()
    // scripted 用量=input 100 + output 200 合计,缓存读/写为零——零值段不渲染是设计(不伪造零宽段)
    await expect(bar.locator('.token-segment')).toHaveCount(2)
    await bar.hover()
    // tooltip 带 opacity 过渡,等动画走完再断言终值
    await expect
      .poll(
        async () =>
          // tsconfig.node 无 DOM lib:结构化类型拿 getComputedStyle(回调实际在渲染进程里跑)
          bar.evaluate((el) =>
            (globalThis as unknown as {
              getComputedStyle(e: unknown, pseudo: string): { readonly opacity: string }
            }).getComputedStyle(el, '::after').opacity,
          ),
        { timeout: 3000 },
      )
      .toBe('1')
    await card.getByRole('button', { name: '收起细节' }).click()

    await card.getByRole('button', { name: '查看完整过程' }).click()
    // A-28(0.5.0 第三批):「查看完整过程」收编进协作链面板详情态,pin 这张卡的 tab,不切整页
    const panel = win.locator('.collab-panel')
    await expect(panel).toHaveClass(/is-detail/, { timeout: 10000 })
    await expect(panel.locator('.collab-tab.is-active')).toContainText('账房')
    await expect(panel.locator('.run-process-pane')).toContainText(task, { timeout: 10000 })
    await expect(panel.locator('.run-process-pane')).toContainText('已按任务简报完成处理')
    // 旧整页详情路由已删;对话区没离开(输入框还在)
    await expect(win.locator('.run-detail-pane')).toHaveCount(0)
    await expect(win.locator('textarea')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('越界 scripted 场景在完成卡细节展示 boundary violations', async () => {
  const task = 'E2E scripted 越界任务'
  const scene = await seedScenarioWorkspace()
  await seedAwaitingRun(scene.userDataDir, scene.workspace, 'run-e2eb1c2d3e4f5a67', task)
  const { app, win } = await launchApp(scene.userDataDir, 'manager-boundary')
  try {
    const card = win.locator('.delegation-card', { hasText: task })
    await expect(card.getByRole('button', { name: '同意派出' })).toBeVisible()
    await card.getByRole('button', { name: '同意派出' }).click()
    await expect(card).toContainText('干完了', { timeout: 30_000 })
    await card.getByRole('button', { name: '展开细节' }).click()
    await expect(card).toContainText('越界记录')
    await expect(card).toContainText('C:\\daweige-e2e-outside\\blocked.txt')
    await expect(card).toContainText('路径不在本次派活允许的文件夹内')
  } finally {
    await app.close()
  }
})
