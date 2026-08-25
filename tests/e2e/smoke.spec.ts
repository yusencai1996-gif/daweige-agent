import { test, expect, _electron as electron } from '@playwright/test'

/**
 * M7-02 E2E 冒烟:真实启动 Electron(生产构建产物)。
 * 覆盖:窗口加载、标题、安全边界(渲染进程无 Node 访问)、只暴露声明过的桥。
 * 完整交互 E2E(会话/流式/确认卡)在 M8 前补齐;此处先冻结安全底线。
 */

test('应用启动:标题正确 + 渲染进程无 Node 访问 + 只暴露声明过的桥', async () => {
  const app = await electron.launch({
    args: ['out/main/index.js'],
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  await expect(window).toHaveTitle(/大微阁/)

  // 安全断言:contextIsolation 下渲染进程拿不到 require/process
  const checks = await window.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    return {
      hasRequire: typeof w['require'],
      hasProcess: typeof w['process'],
      bridgeKeys: w['daweige'] ? Object.keys(w['daweige'] as object).sort() : null,
    }
  })
  expect(checks.hasRequire).toBe('undefined')
  expect(checks.hasProcess).toBe('undefined')
  // 只暴露契约桥的 invoke/onAgentEvent
  expect(checks.bridgeKeys).toEqual(['invoke', 'onAgentEvent'])

  await app.close()
})
