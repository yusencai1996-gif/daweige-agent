import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoleRepository } from '../../src/main/roles/role-repository'
import { RoleService } from '../../src/main/roles/role-service'

let userData: string
let workspace: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'skills-v060-e2e-'))
  workspace = await mkdtemp(join(tmpdir(), 'skills-v060-ws-'))
  const repo = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
  const roles = new RoleService(userData, repo)
  for (const [name, templateId] of [
    ['账房', 'accountant'], ['小编', 'writer'], ['管家', 'file-steward'],
  ] as const) {
    const cwd = join(workspace, name)
    await mkdir(cwd, { recursive: true })
    await roles.createRole({ displayName: name, workspacePaths: [cwd], primaryWorkspacePath: cwd, templateId, guardrails: '' })
  }
  await repo.drainAndClose()
  await putSkill('custom-checklist', `---\nname: custom-checklist\ndescription: 自装核对清单\n---\n# 自装技能正文`)
  await putSkill('broken-skill', `---\nname: INVALID NAME\n---\n坏技能`)
})

test.afterAll(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

async function putSkill(name: string, content: string): Promise<void> {
  const dir = join(userData, 'daweige', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

test('技能管理：五个默认技能、自装/诊断、刷新与三档宽度无横向滚动', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, DAWEIGE_USER_DATA: userData } })
  try {
    const win = await app.firstWindow()
    await win.waitForTimeout(2200)
    await win.getByRole('button', { name: '设置' }).click()
    await win.getByRole('tab', { name: '技能' }).click()
    for (const name of ['skill-creator', 'delegation-breakdown', 'multi-sheet-reconcile', 'work-report-writing', 'files-and-photos-organize', 'custom-checklist']) {
      await expect(win.locator('.skill-item-name', { hasText: name })).toBeVisible()
    }
    // broken-skill 产生两条诊断(缺 description + name 与目录名不符),条数不绑死
    await expect(win.getByText(/有 \d+ 个技能没读出来/)).toBeVisible()

    await putSkill('after-refresh', `---\nname: after-refresh\ndescription: 刷新后出现\n---\n# 新技能`)
    await win.getByRole('button', { name: '刷新' }).click()
    await expect(win.locator('.skill-item-name', { hasText: 'after-refresh' })).toBeVisible()

    for (const size of [{ width: 720, height: 800 }, { width: 1100, height: 800 }, { width: 1440, height: 900 }]) {
      await win.setViewportSize(size)
      expect(await win.evaluate(() => {
        const browser = globalThis as unknown as {
          document: { documentElement: { scrollWidth: number } }
          innerWidth: number
        }
        return browser.document.documentElement.scrollWidth <= browser.innerWidth
      })).toBe(true)
    }
  } finally {
    await app.close()
  }
})

async function launchAuthoring(scenario: string): Promise<{
  app: ElectronApplication
  win: Page
  userData: string
  workspace: string
}> {
  const isolatedUserData = await mkdtemp(join(tmpdir(), 'skill-authoring-e2e-'))
  const isolatedWorkspace = await mkdtemp(join(tmpdir(), 'skill-authoring-ws-'))
  const repo = new (await import('../../src/main/storage/session-repository')).SessionRepository(
    join(isolatedUserData, 'data', 'sessions.sqlite'),
  )
  await repo.init()
  await repo.create({ cwd: isolatedWorkspace, providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  await repo.close()
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      DAWEIGE_USER_DATA: isolatedUserData,
      DAWEIGE_E2E_SCENARIO: scenario,
    },
  })
  const win = await app.firstWindow()
  await win.waitForTimeout(2500)
  await win.getByRole('button', { name: '设置' }).click()
  await win.locator('#api-key-input').fill('sk-e2e-fake-key')
  await win.getByRole('button', { name: '保存 key' }).click()
  await win.getByRole('button', { name: /回到聊天/ }).click()
  await win.getByRole('button', { name: /skill-authoring-ws/ }).first().click()
  await win.locator('.session-item', { hasText: '新会话' }).first().click()
  return { app, win, userData: isolatedUserData, workspace: isolatedWorkspace }
}

async function closeAuthoring(app: ElectronApplication, ...paths: string[]): Promise<void> {
  await app.close()
  for (const path of paths) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

test('skill-authoring: 可复用活询问一次→WRITE 完整预览→批准→自创技能→新会话读取', async () => {
  const { app, win, userData: data, workspace: ws } = await launchAuthoring('skill-authoring-happy')
  try {
    await win.locator('textarea').fill('把这批重复文件整理好并核对结果')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('这个做法以后还会复用吗？', { timeout: 15000 })

    await win.locator('textarea').fill('会，帮我整理成技能')
    await win.getByRole('button', { name: '发送' }).click()
    const card = win.locator('.approval-card', { hasText: '全局技能 / reusable-cleanup' })
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('name: reusable-cleanup')
    await expect(card).toContainText('新对话生效')
    await card.getByRole('button', { name: '写进去' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('新建对话后可用', { timeout: 15000 })

    await win.getByRole('button', { name: '设置' }).click()
    await win.getByRole('tab', { name: '技能' }).click()
    const row = win.locator('.skill-item', { hasText: 'reusable-cleanup' })
    await expect(row).toContainText('自创')
    await win.getByRole('button', { name: /回到聊天/ }).click()
    await win.getByRole('button', { name: '＋ 新会话' }).first().click()
    await win.locator('textarea').fill('读取刚创作的技能')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('成功读取 reusable-cleanup', { timeout: 15000 })
  } finally {
    await closeAuthoring(app, data, ws)
  }
})

test('skill-authoring: 连续三个普通活不询问；直接要求写技能不追问是否保存', async () => {
  const ordinary = await launchAuthoring('skill-authoring-ordinary')
  try {
    for (const request of ['今天天气怎样', '翻译一句话', '你好']) {
      await ordinary.win.locator('textarea').fill(request)
      await ordinary.win.getByRole('button', { name: '发送' }).click()
      await expect(ordinary.win.locator('.msg-assistant').last()).toBeVisible({ timeout: 15000 })
    }
    await expect(ordinary.win.locator('.message-column')).not.toContainText('这个做法以后还会复用吗？')
  } finally {
    await closeAuthoring(ordinary.app, ordinary.userData, ordinary.workspace)
  }

  const direct = await launchAuthoring('skill-authoring-direct')
  try {
    await direct.win.locator('textarea').fill('帮我写个重复文件整理技能')
    await direct.win.getByRole('button', { name: '发送' }).click()
    await expect(direct.win.locator('.message-column')).not.toContainText('这个做法以后还会复用吗？')
    const card = direct.win.locator('.approval-card', { hasText: '全局技能 / reusable-cleanup' })
    await expect(card).toBeVisible({ timeout: 15000 })
    await card.getByRole('button', { name: '先别动' }).click()
  } finally {
    await closeAuthoring(direct.app, direct.userData, direct.workspace)
  }
})
