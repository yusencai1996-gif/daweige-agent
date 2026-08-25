import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'
import { SessionService } from '../../src/main/storage/session-service'
import { RoleRepository } from '../../src/main/roles/role-repository'
import { RoleService } from '../../src/main/roles/role-service'

/**
 * 0.2.0 角色化 E2E(PLAN §10.5 精简):真实 Electron+真实 IPC。
 * userData 注入临时目录(DAWEIGE_USER_DATA),fixture 用项目源码类预置,
 * 不触碰真实开发库;不依赖模型对话(对话生效语义在 prompt-refresh 集成测试覆盖)。
 * 三步向导的文件选择流程(系统对话框)由 mock 预览测试覆盖,此处不重复。
 */

let userData: string
let wsDir: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'roles-e2e-'))
  wsDir = await mkdtemp(join(tmpdir(), 'roles-e2e-ws-'))
  await mkdir(join(wsDir, '稿件'), { recursive: true })

  // fixture:两个旧会话(同 cwd 中文目录,一个带历史消息)+ 一个 cwd 已消失的会话 → 启动时自动迁移归组
  const sessionRepo = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  await sessionRepo.create({ cwd: join(wsDir, '稿件'), providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  const s2 = await sessionRepo.create({ cwd: join(wsDir, '稿件'), providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  await s2.appendMessage({ role: 'user', content: '帮我把稿子整理一下', timestamp: Date.now() })
  await sessionRepo.create({ cwd: join(wsDir, '已经不存在的目录'), providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  await sessionRepo.close()
})

test.afterAll(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  await rm(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

async function launchApp(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, DAWEIGE_USER_DATA: userData },
  })
  app.process().stdout?.on('data', (d: Buffer) => console.log('[MAIN]', d.toString().trim()))
  app.process().stderr?.on('data', (d: Buffer) => console.log('[MAIN-ERR]', d.toString().trim()))
  const win = await app.firstWindow()
  await win.waitForTimeout(2500) // 迁移+bootstrap
  return { app, win }
}

test('老会话启动自动归组:同文件夹归一角色,消失目录独立成组,历史可打开', async () => {
  const { app, win } = await launchApp()
  try {
    // 「稿件」角色卡上墙(同 cwd 两个会话归一个)
    const card = win.locator('.role-card', { hasText: '稿件' })
    await expect(card).toBeVisible()
    await card.locator('.role-card-head').click()
    await win.waitForTimeout(400)
    // 角色下能看到旧会话
    await expect(win.locator('.session-item').first()).toBeVisible()
    // 点开旧会话进入聊天
    await win.locator('.session-item').first().click()
    await win.waitForTimeout(800)
    const body = await win.textContent('body')
    expect(body).toContain('帮我把稿子整理一下')

    // 消失目录的角色存在(missing/unresolved 态,不丢)
    const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
    const rows = await roleRepo.listRoleRows()
    expect(rows.length).toBeGreaterThanOrEqual(2)
    await roleRepo.drainAndClose()
  } finally {
    await app.close()
  }
})

test('预建角色下建会话→守则编辑保存→会话归档恢复', async () => {
  // fixture:直接用 RoleService 预建角色(绕过向导的系统对话框)
  const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const roleService = new RoleService(userData, roleRepo)
  const accountWs = join(wsDir, '账房工作区')
  await mkdir(accountWs, { recursive: true })
  const detail = await roleService.createRole({
    displayName: '账房',
    workspacePaths: [accountWs],
    primaryWorkspacePath: accountWs,
    templateId: 'accountant',
    guardrails: '# 角色守则\n\n## 身份\n你是账房。',
  })
  const roleId = detail.summary.id
  await roleRepo.drainAndClose()

  const { app, win } = await launchApp()
  try {
    // 展开账房 → 和他聊聊 → 空会话
    const card = win.locator('.role-card', { hasText: '账房' })
    await expect(card).toBeVisible()
    await card.locator('.role-card-head').click()
    await win.waitForTimeout(800)
    await card.getByRole('button', { name: '和他聊聊' }).click()
    await win.waitForTimeout(1200)
    expect(await win.textContent('body')).toContain('这还是个空会话')

    // 守则编辑:菜单 → 编辑守则 → 改 → 保存
    await card.getByRole('button', { name: '「账房」的操作' }).click()
    await win.getByText('编辑守则').click()
    await win.waitForTimeout(800)
    expect(await win.textContent('body')).toContain('保存后,从下一条消息开始生效')
    const textarea = win.locator('textarea')
    await textarea.fill('# 角色守则\n\n## 身份\n你是账房(E2E 修改版)。')
    await win.getByRole('button', { name: '保存' }).click()
    await win.waitForTimeout(800)

    // 落库验证(守则真写了)
    const verifyRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
    const verifyService = new RoleService(userData, verifyRepo)
    const after = await verifyService.readGuardrailsOf(roleId)
    expect(after.text).toContain('E2E 修改版')
    expect(after.version).toBe(2)
    await verifyRepo.drainAndClose()

    // 会话归档 → 恢复(⋯ 钮与菜单都在行容器内:hover 行 → 点⋯ → 点菜单「归档」)
    await win.getByRole('button', { name: /返回|‹/ }).first().click().catch(() => {})
    const sessionRow = win.locator('.session-item', { hasText: '新会话' }).first()
    await sessionRow.hover({ position: { x: 8, y: 8 } })
    await win.waitForTimeout(300)
    const rowBox = sessionRow.locator('..')
    await rowBox.getByRole('button', { name: '「新会话」的会话操作' }).click()
    await rowBox.getByRole('menuitem', { name: '归档' }).click()
    await win.waitForTimeout(800)
    await expect(win.locator('.session-item', { hasText: '新会话' })).toHaveCount(0)

    await win.getByRole('button', { name: /归档 \d+/ }).click()
    await win.waitForTimeout(600)
    // 归档会话在「会话」页签(角色页签默认打开且此处为空)
    await win.getByRole('tab', { name: /会话 \d+/ }).click()
    await win.waitForTimeout(400)
    await win.getByRole('button', { name: '恢复' }).first().click()
    await win.waitForTimeout(600)
  } finally {
    await app.close()
  }
})

test('角色删除:影响清单→输名确认→子会话与注册行消失,家目录清除', async () => {
  // fixture:建带两个会话的角色
  const sessionRepo = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const roleService = new RoleService(userData, roleRepo, sessionRepo)
  const delWs = join(wsDir, '待删管家工作区')
  await mkdir(delWs, { recursive: true })
  const detail = await roleService.createRole({
    displayName: '待删管家',
    workspacePaths: [delWs],
    primaryWorkspacePath: delWs,
    templateId: 'file-steward',
    guardrails: '',
  })
  const sessionService = new SessionService(sessionRepo, roleRepo, roleService)
  const s1 = await sessionService.create({ roleId: detail.summary.id, providerId: 'kimi-coding', modelId: 'm' })
  const s2 = await sessionService.create({ roleId: detail.summary.id, providerId: 'kimi-coding', modelId: 'm' })
  // 释放 pi writer lease:测试进程持有不放,应用进程删会话会报 already has an active writer
  await sessionRepo.close()
  const homeDir = join(userData, 'daweige', 'agents', detail.summary.id)
  expect(existsSync(join(homeDir, 'guardrails.md'))).toBe(true)

  const { app, win } = await launchApp()
  try {
    const card = win.locator('.role-card', { hasText: '待删管家' })
    await card.locator('.role-card-head').click()
    await card.getByRole('button', { name: '「待删管家」的操作' }).click()
    await win.getByText('删除').last().click()
    await win.waitForTimeout(800)
    // 影响清单
    expect(await win.textContent('body')).toContain('会话正文和角色守则会永久删除;使用统计保留')
    // 错名:按钮禁用;输名:可删
    const input = win.locator('input')
    await input.fill('错名字')
    const deleteBtn = win.getByRole('button', { name: '彻底删除' })
    await expect(deleteBtn).toBeDisabled()
    await input.fill('待删管家')
    await expect(deleteBtn).toBeEnabled()
    await deleteBtn.click()
    await win.waitForTimeout(1500)

    await expect(win.locator('.role-card', { hasText: '待删管家' })).toHaveCount(0)
  } finally {
    await app.close()
  }

  // 落库验证:注册行/绑定清空,家目录删除,pi 会话删除
  const finalRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  expect(await finalRepo.getRoleRow(detail.summary.id)).toBeUndefined()
  // 被删角色的绑定清空;其他角色(稿件/消失目录的迁移绑定)不受影响
  const allBindings = await finalRepo.listBindingRows()
  expect(allBindings.filter((b) => b.roleId === detail.summary.id)).toHaveLength(0)
  await finalRepo.drainAndClose()
  expect(existsSync(homeDir)).toBe(false)
  const finalSessions = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await finalSessions.init()
  const remaining = await finalSessions.list()
  expect(remaining.some((m) => m.id === s1.summary.id || m.id === s2.summary.id)).toBe(false)
  await finalSessions.close()
})

test('迁移幂等:重复启动不重复归组', async () => {
  // 本测试自驱动:先启动一次触发迁移作为基线(不依赖其他测试的执行顺序)
  const first = await launchApp()
  await first.app.close()
  const roleRepo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const before = await roleRepo.listRoleRows()
  await roleRepo.drainAndClose()
  expect(before.length).toBeGreaterThan(0) // fixture 旧会话应已归组

  const { app } = await launchApp()
  await app.close()

  const roleRepo2 = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const after = await roleRepo2.listRoleRows()
  await roleRepo2.drainAndClose()
  expect(after.length).toBe(before.length)
})
