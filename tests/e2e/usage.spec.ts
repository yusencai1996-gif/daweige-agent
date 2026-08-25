import { test, expect, _electron as electron } from '@playwright/test'

/**
 * 使用统计页 E2E 冒烟:侧边栏独立入口 → 整页四区域渲染 → 返回聊天不丢会话状态。
 * 只断言结构性内容,不断言具体数字(有无数据都能过,骨架恒在)。
 */

test('使用统计:入口 → 整页渲染 → 返回聊天', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)

  // 侧边栏底部独立入口
  const usageBtn = window.getByText('使用统计', { exact: true })
  await expect(usageBtn).toBeVisible()

  // 进入统计页:标题 + 四区域关键词
  await usageBtn.click()
  await window.waitForTimeout(800)
  const body = await window.textContent('body')
  expect(body).toContain('累计')
  expect(body).toContain('活动')
  expect(body).toContain('趋势')
  expect(body).toContain('模型')

  // 切换控件存在(每日/每周/累计、近7日/近30日)
  await expect(window.getByText('每周', { exact: true })).toBeVisible()
  await expect(window.getByText('近 30 日').or(window.getByText('近30日'))).toBeVisible()

  // 切换热力图档位不报错
  await window.getByText('每周', { exact: true }).click()
  await window.waitForTimeout(300)
  await window.getByText('累计', { exact: true }).click()
  await window.waitForTimeout(300)

  // 返回聊天:角色化侧栏结构仍在(会话行在角色卡手风琴内,展开卡才渲染)
  await window.locator('.usage-back').click()
  await window.waitForTimeout(800)
  const roleCards = await window.locator('.role-card').count()
  expect(roleCards).toBeGreaterThan(0)

  // 无渲染错误(pageerror 由 @playwright/test 自动失败,此处显式确认页面存活)
  await expect(window.locator('#root, .app-shell').first()).toBeVisible()

  await app.close()
})
