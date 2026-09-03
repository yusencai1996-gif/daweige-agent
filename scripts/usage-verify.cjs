// 使用统计页联调验证:启动应用 → 点侧边栏「使用统计」→ 截图 + 关键元素断言
const electron = require('playwright')._electron

;(async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const win = await app.firstWindow()
  await win.waitForTimeout(2500)

  // 回填是启动后异步跑的,等它有时间完成(历史会话扫描)
  await win.waitForTimeout(3000)

  // 侧边栏「使用统计」按钮存在
  const usageBtn = win.getByText('使用统计', { exact: true })
  console.log('usage button visible =', await usageBtn.isVisible())

  // 点击进入统计页
  await usageBtn.click()
  await win.waitForTimeout(2000)

  const body = await win.textContent('body')
  console.log('页面含 累计 =', body.includes('累计'))
  console.log('页面含 热力/活动 =', body.includes('活动'))
  console.log('页面含 趋势 =', body.includes('趋势'))
  console.log('页面含 模型 =', body.includes('模型'))

  await win.screenshot({ path: 'docs/design/acceptance-check/usage-page-dev.png', fullPage: false })
  console.log('screenshot saved: usage-page-dev.png')

  // 拿五卡的原始文本(数字部分)
  const cards = await win.locator('.usage-card, [class*="overview"]').allTextContents().catch(() => [])
  console.log('cards =', JSON.stringify(cards.slice(0, 6)))

  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
