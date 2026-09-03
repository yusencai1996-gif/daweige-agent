// A-10/A-13 真机验收:设置页在线拉模型列表(真 key,GET 只读)+聊天区角色名
const { _electron: electron } = require('playwright')
;(async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const win = await app.firstWindow()
  await win.waitForTimeout(3000)
  const out = {}

  // A-13:展开第一个角色卡,打开会话,读 AI 气泡名(有历史消息才显示气泡;零消息则读欢迎页)
  const heads = win.locator('.role-card .role-card-head')
  const cardCount = await heads.count()
  if (cardCount > 0) {
    const cardName = (await win.locator('.role-card').first().locator('.role-name').textContent().catch(() => null))?.trim()
    await heads.first().click()
    await win.waitForTimeout(400)
    const rows = win.locator('.session-item')
    if ((await rows.count()) > 0) {
      await rows.first().click()
      await win.waitForTimeout(1200)
      const roles = await win.locator('.msg-role').allTextContents()
      out.a13 = { cardName, msgRoles: [...new Set(roles)] }
    } else {
      out.a13 = { cardName, note: '角色无会话,读空态标题', welcome: (await win.locator('.welcome-title').textContent().catch(() => null))?.trim() }
    }
  } else {
    out.a13 = { note: '无角色(dev 库空?)' }
  }

  // A-10:进设置页,逐家点"获取模型列表"(真 key 在主进程,在线拉)
  await win.getByText('设置', { exact: true }).click()
  await win.waitForTimeout(800)
  const panels = {}
  for (const name of ['Kimi', 'GLM（国内）', 'DeepSeek']) {
    const panel = win.locator('.cred-panel, [class*="provider"]').filter({ hasText: name }).first()
    if (!(await panel.count())) { panels[name] = 'panel not found'; continue }
    const btn = panel.getByRole('button', { name: /获取模型列表/ })
    if (!(await btn.count())) { panels[name] = 'button not found'; continue }
    if (await btn.isDisabled()) { panels[name] = '按钮禁用(未填 key)'; continue }
    await btn.click()
    await win.waitForTimeout(6000) // 在线拉取窗口
    const selectText = await panel.locator('select').first().textContent().catch(() => null)
    const notice = await panel.locator('[class*="notice"], .model-notice').first().textContent().catch(() => null)
    const options = await panel.locator('select option').allTextContents().catch(() => [])
    panels[name] = { options: options.slice(0, 8), notice: notice?.trim() ?? null, selectHasValue: !!selectText }
  }
  out.a10 = panels

  await win.screenshot({ path: 'docs/design/acceptance-check/a10-a13-real.png', fullPage: false })
  await app.close()
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
