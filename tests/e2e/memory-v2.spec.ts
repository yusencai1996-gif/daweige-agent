import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../../src/main/memory/memory-store'

let userData: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'memory-v2-e2e-'))
  const legacy = new MemoryStore(join(userData, 'data', 'memories.json'))
  await legacy.add({
    text: '妈妈生日是三月五号', title: '妈妈生日', category: '生日',
    date: { kind: 'recurring', month: 3, day: 5 },
  })
  await legacy.add({
    text: 'api_key=abcdefghijklmnopqrs', title: '敏感内容', category: '事实',
  })
})

test.afterAll(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

test('旧记忆迁移、UI 打码/来源/时间、单删与清空取消/确认', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, DAWEIGE_USER_DATA: userData } })
  try {
    const win = await app.firstWindow()
    await win.waitForTimeout(2200)
    await win.getByRole('button', { name: '设置' }).click()
    await win.getByRole('tab', { name: '记忆管理' }).click()
    await expect(win.locator('.memory-item')).toHaveCount(2)
    await expect(win.getByText('妈妈生日是三月五号')).toBeVisible()
    await expect(win.getByText('旧生活记事').first()).toBeVisible()
    await expect(win.locator('.memory-item-time').first()).toContainText('记下')
    expect(await win.textContent('body')).not.toContain('abcdefghijklmnopqrs')

    const birthday = win.locator('.memory-item', { hasText: '妈妈生日是三月五号' })
    await birthday.getByRole('button', { name: '删除' }).click()
    await birthday.getByRole('button', { name: '确认删除?' }).click()
    await expect(birthday).toHaveCount(0)

    await win.getByRole('button', { name: '一键清空' }).click()
    await expect(win.getByRole('dialog', { name: '清空全部记忆' })).toBeVisible()
    await win.getByRole('button', { name: '先不清' }).click()
    await expect(win.locator('.memory-item')).toHaveCount(1)

    await win.getByRole('button', { name: '一键清空' }).click()
    await win.getByRole('button', { name: '确认清空' }).click()
    await expect(win.locator('.memory-item')).toHaveCount(0)
    await expect(win.getByText(/还没让它记住过什么/)).toBeVisible()
  } finally {
    await app.close()
  }
})
