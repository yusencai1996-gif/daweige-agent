import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'

/**
 * 0.4.0 C 线 E2E:command-happy 全链(弹卡→批准→实时输出→完成→模型继续)。
 * 双门纪律同 0.3 E2E:非打包 + 独立 userData 才注入 fake;
 * 只替换模型流(faux)与 OS spawn(FakeSandboxExecutor),
 * agent loop/事件流/ExecPolicy/审批卡/工具编排/UI 渲染全真。
 */

let userData: string
let workspace: string
let rejectUserData: string
let rejectWorkspace: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'command-e2e-'))
  workspace = await mkdtemp(join(tmpdir(), 'command-e2e-ws-'))
  await mkdir(join(workspace, '报表'), { recursive: true })
  rejectUserData = await mkdtemp(join(tmpdir(), 'command-e2e-rej-'))
  rejectWorkspace = await mkdtemp(join(tmpdir(), 'command-e2e-rej-ws-'))
  await mkdir(join(rejectWorkspace, '报表'), { recursive: true })
})

test.afterAll(async () => {
  for (const dir of [userData, workspace, rejectUserData, rejectWorkspace]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})

/** fixture:直写一个无绑定 pi 会话(cwd=工作区),启动迁移归 worker 角色。 */
async function seedPlainSession(dir: string, ws: string): Promise<void> {
  const sessionRepo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  await sessionRepo.create({
    cwd: ws,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
  })
  await sessionRepo.close()
}

/** E2E 里走真实设置页存一个假 key(faux 模型不会消费它;只为通过发送前的配置检查)。 */
async function seedFakeKey(win: Page): Promise<void> {
  await win.getByRole('button', { name: '设置' }).click()
  const keyInput = win.locator('#api-key-input')
  await expect(keyInput).toBeVisible()
  await keyInput.fill('sk-e2e-fake-key')
  await win.getByRole('button', { name: '保存 key' }).click()
  await win.getByRole('button', { name: /回到聊天/ }).click()
  await win.waitForTimeout(300)
}

async function launchApp(dir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAWEIGE_USER_DATA: dir,
      DAWEIGE_E2E_SCENARIO: 'command-happy',
    },
  })
  app.process().stdout?.on('data', (d: Buffer) => console.log('[MAIN]', d.toString().trim()))
  app.process().stderr?.on('data', (d: Buffer) => console.log('[MAIN-ERR]', d.toString().trim()))
  const win = await app.firstWindow()
  await win.waitForTimeout(2500) // 迁移+种子化+bootstrap
  return { app, win }
}

test('command-happy:发消息→faux 模型要跑命令→弹命令卡→批准→输出回传→模型收尾', async () => {
  await seedPlainSession(userData, workspace)
  const { app, win } = await launchApp(userData)
  try {
    await seedFakeKey(win)

    // 1) 打开该会话:worker 角色分组默认折叠,先展开(手风琴:展开后可见"新会话"就是它)
    const groupToggle = win.getByRole('button', { name: /command-e2e-ws/ }).first()
    await expect(groupToggle).toBeVisible({ timeout: 10000 })
    await groupToggle.click()
    const sessionItem = win.locator('.session-item', { hasText: '新会话' }).first()
    await expect(sessionItem).toBeVisible({ timeout: 5000 })
    await sessionItem.click()
    await win.waitForTimeout(500)

    // 2) 发消息
    const textarea = win.locator('textarea')
    await textarea.fill('帮我统计一下这个文件夹的行数')
    await win.getByRole('button', { name: '发送' }).click()

    // 3) 命令确认卡弹出:原文等宽展示 + 网络如实灰档 + 三按钮语义
    const card = win.locator('.command-approval-card')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card.locator('.approval-command')).toContainText('python summarize.py')
    await expect(card.locator('.command-net-note')).toContainText('未隔离网络')
    const approveBtn = card.getByRole('button', { name: '只运行这一次' })
    await expect(approveBtn).toBeVisible()
    await expect(card.getByRole('button', { name: '本会话允许这条相同命令' })).toBeVisible()
    await expect(card.getByRole('button', { name: '不运行' })).toBeVisible()

    // 4) 批准 → fake 沙箱执行 → 输出回传
    await approveBtn.click()

    // 5) CommandBlock 出现并落到消息流;展开看输出与退出码
    const block = win.locator('.command-block').first()
    await expect(block).toBeVisible({ timeout: 15000 })
    await block.getByRole('button', { name: /过程输出/ }).click()
    await expect(block.locator('.command-output').first()).toContainText('合计 42 行')
    await expect(block.locator('.command-exit').first()).toContainText('退出码 0')

    // 6) 工具完成后模型继续,终文本落地(faux 第二步)
    await expect(win.locator('.msg-assistant').last()).toContainText('看完了', { timeout: 15000 })

    // 7) 审批卡从浮层消失(终态收卡)
    await expect(card).toBeHidden({ timeout: 10000 })
  } finally {
    await app.close()
  }
})

test('command-happy:拒绝路径→不执行→卡收掉→模型收到拒绝原因继续收尾', async () => {
  await seedPlainSession(rejectUserData, rejectWorkspace)
  const { app, win } = await launchApp(rejectUserData)
  try {
    await seedFakeKey(win)
    const groupToggle = win.getByRole('button', { name: /command-e2e-rej-ws/ }).first()
    await expect(groupToggle).toBeVisible({ timeout: 10000 })
    await groupToggle.click()
    const sessionItem = win.locator('.session-item', { hasText: '新会话' }).first()
    await expect(sessionItem).toBeVisible({ timeout: 5000 })
    await sessionItem.click()
    await win.waitForTimeout(500)

    const textarea = win.locator('textarea')
    await textarea.fill('帮我统计一下这个文件夹的行数')
    await win.getByRole('button', { name: '发送' }).click()

    const card = win.locator('.command-approval-card')
    await expect(card).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '不运行' }).click()

    // 卡从浮层消失(拒绝即收);不出现命令过程块(fake 沙箱从未被调)
    await expect(card).toBeHidden({ timeout: 10000 })
    await expect(win.locator('.command-block')).toHaveCount(0)
    // 模型收到"用户没有批准"的工具结果后继续收尾(faux 第二步)
    await expect(win.locator('.msg-assistant').last()).toContainText('看完了', { timeout: 15000 })
  } finally {
    await app.close()
  }
})
