// 0.7.0 E-4/E-7:记忆分页「加载更多」与清空弹层焦点闭环的 E2E。
// 种 120 条真实记忆(GlobalMemoryStore 直写临时 userData),启动真实应用验证:
// 首屏 50 → 加载更多追加到 100/120;弹层初始焦点/Tab 循环/Escape/焦点归还。
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalMemoryStore } from '../../src/main/memory/global-memory-store'

const TOTAL = 120
let userData: string

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'memory-paging-e2e-'))
  const store = new GlobalMemoryStore(join(userData, 'daweige', 'memory'))
  await store.initialize()
  for (let i = 1; i <= TOTAL; i += 1) {
    await store.addGeneratedNote(
      { text: `分页测试第 ${i} 条内容`, title: `分页-${String(i).padStart(3, '0')}` },
      { kind: 'conversation', roleId: 'sys-xiaozhen', roleDisplayName: '小柊' },
    )
  }
})

test.afterAll(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

async function launchToMemoryTab() {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, DAWEIGE_USER_DATA: userData },
  })
  const win = await app.firstWindow()
  await win.waitForTimeout(2200)
  await win.getByRole('button', { name: '设置' }).click()
  await win.getByRole('tab', { name: '记忆管理' }).click()
  return { app, win }
}

test('E-4 分页:首屏 50,加载更多逐页追加到 100/120,翻完按钮消失', async () => {
  const { app, win } = await launchToMemoryTab()
  try {
    await expect(win.locator('.memory-item')).toHaveCount(50)
    const more = win.getByRole('button', { name: /加载更多|正在翻页/ })
    await expect(more).toHaveText(`加载更多(已显示 50/共 ${TOTAL})`)

    await more.click()
    await expect(win.locator('.memory-item')).toHaveCount(100)
    await expect(more).toHaveText(`加载更多(已显示 100/共 ${TOTAL})`)

    await more.click()
    await expect(win.locator('.memory-item')).toHaveCount(TOTAL)
    await expect(win.getByRole('button', { name: /加载更多/ })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('E-7 清空弹层:初始焦点在「先不清」,Tab 循环,Escape 关闭并归还焦点', async () => {
  const { app, win } = await launchToMemoryTab()
  try {
    const trigger = win.getByRole('button', { name: '一键清空' })
    await trigger.click()
    const dialog = win.getByRole('dialog', { name: '清空全部记忆' })
    await expect(dialog).toBeVisible()
    // 分页场景弹层条数取 total(120),不是已加载条数
    await expect(dialog).toContainText(`将删除全部 ${TOTAL} 条记忆`)

    const cancel = win.getByRole('button', { name: '先不清' })
    const confirm = win.getByRole('button', { name: '确认清空' })

    // 初始焦点放「先不清」(取消),不是确认钮
    await expect(cancel).toBeFocused()

    // Tab 在弹层内循环:先不清 → 确认清空 → 先不清;Shift+Tab 反向
    await win.keyboard.press('Tab')
    await expect(confirm).toBeFocused()
    await win.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await win.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()

    // Escape 关闭弹层,焦点归还触发按钮「一键清空」
    await win.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    // 取消路径不删:列表仍是第一页 50 条
    await expect(win.locator('.memory-item')).toHaveCount(50)
  } finally {
    await app.close()
  }
})
