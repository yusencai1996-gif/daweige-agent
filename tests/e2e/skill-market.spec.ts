import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepository } from '../../src/main/storage/session-repository'

const roots: string[] = []
test.afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

async function launch(scenario: string): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'skill-market-e2e-'))
  const workspace = await mkdtemp(join(tmpdir(), 'skill-market-ws-'))
  roots.push(userData, workspace)
  const repo = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  await repo.init()
  await repo.create({ cwd: workspace, providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
  await repo.close()
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, DAWEIGE_USER_DATA: userData, DAWEIGE_E2E_SCENARIO: scenario },
  })
  const win = await app.firstWindow()
  await win.waitForTimeout(2500)
  await win.getByRole('button', { name: '设置' }).click()
  await win.locator('#api-key-input').fill('sk-e2e-fake-key')
  await win.getByRole('button', { name: '保存 key' }).click()
  await win.getByRole('button', { name: /回到聊天/ }).click()
  const group = win.getByRole('button', { name: /skill-market-ws/ }).first()
  await group.click()
  await win.locator('.session-item', { hasText: '新会话' }).first().click()
  return { app, win, userData }
}

async function startSearch(win: Page): Promise<void> {
  await win.locator('textarea').fill('帮我安装会议纪要技能')
  await win.getByRole('button', { name: '发送' }).click()
  await expect(win.getByRole('radiogroup', { name: '搜到的技能候选' })).toBeVisible({ timeout: 15000 })
}

test('faux registry: 选择第二项→只安装第二项→来源展示→回收站卸载', async () => {
  const { app, win } = await launch('skill-market-happy')
  try {
    await startSearch(win)
    await win.locator('.skill-candidate-option', { hasText: 'Faux Second' }).click()
    await win.getByRole('button', { name: '选这个' }).click()
    const install = win.locator('.skill-approval-card', { hasText: '安装技能「faux-second」' })
    await expect(install).toBeVisible({ timeout: 15000 })
    await expect(install).toContainText('name: faux-second')
    await install.getByRole('button', { name: '装它' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('安装流程已经结束', { timeout: 15000 })
    await win.locator('textarea').fill('旧会话现在读取这个技能')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('旧会话按冻结快照没有', { timeout: 15000 })
    await win.getByRole('button', { name: '＋ 新会话' }).first().click()
    await win.locator('textarea').fill('读取刚安装的技能')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('成功读取 faux-second', { timeout: 15000 })
    await win.getByRole('button', { name: '设置' }).click()
    await win.getByRole('tab', { name: '技能' }).click()
    const row = win.locator('.skill-item', { hasText: 'faux-second' })
    await expect(row).toContainText('精选目录')
    await row.getByRole('button', { name: '卸载' }).click()
    await row.getByRole('button', { name: /确认卸载/ }).click()
    await expect(row).toBeHidden()
  } finally { await app.close() }
})

test('安装预览取消零落盘；含脚本候选拒绝且不弹安装卡', async () => {
  const cancelled = await launch('skill-market-happy')
  try {
    await startSearch(cancelled.win)
    await cancelled.win.locator('.skill-candidate-option', { hasText: 'Faux Second' }).click()
    await cancelled.win.getByRole('button', { name: '选这个' }).click()
    const install = cancelled.win.locator('.skill-approval-card', { hasText: '安装技能「faux-second」' })
    await install.getByRole('button', { name: '先别装' }).click()
    await expect(cancelled.win.locator('.msg-assistant').last()).toContainText('安装流程已经结束', { timeout: 15000 })
    await expect.poll(async () => {
      try { await import('node:fs/promises').then((fs) => fs.access(join(cancelled.userData, 'daweige', 'skills', 'faux-second'))); return true } catch { return false }
    }).toBe(false)
  } finally { await cancelled.app.close() }

  const scripted = await launch('skill-market-script')
  try {
    await startSearch(scripted.win)
    await scripted.win.locator('.skill-candidate-option', { hasText: 'Faux Script' }).click()
    await scripted.win.getByRole('button', { name: '选这个' }).click()
    await expect(scripted.win.locator('.msg-assistant').last()).toContainText('依赖脚本', { timeout: 15000 })
    await expect(scripted.win.getByRole('button', { name: '装它' })).toHaveCount(0)
  } finally { await scripted.app.close() }
})

test('faux 断网返回人话错误且聊天继续', async () => {
  const { app, win } = await launch('skill-market-offline')
  try {
    await win.locator('textarea').fill('搜索技能')
    await win.getByRole('button', { name: '发送' }).click()
    await expect(win.locator('.msg-assistant').last()).toContainText('聊天仍可继续', { timeout: 15000 })
    await expect(win.locator('textarea')).toBeEnabled()
  } finally { await app.close() }
})
