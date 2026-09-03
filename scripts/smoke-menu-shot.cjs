const { _electron: electron } = require('playwright')
;(async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const win = await app.firstWindow()
  await win.waitForTimeout(3000)
  const rowCount = await win.locator('.session-item').count()
  if (rowCount === 0) {
    await win.locator('.role-card .role-card-head').first().click()
    await win.waitForTimeout(400)
  }
  const row = win.locator('.session-item').last()
  await row.hover({ position: { x: 8, y: 8 } })
  await win.waitForTimeout(300)
  await row.locator('..').locator('.session-menu-btn').click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: 'F:/xiaokong-projects/daweige-agent/docs/design/acceptance-check/a11-menu-up-final.png' })
  await app.close()
  console.log('shot ok')
})().catch((e) => { console.error(e); process.exit(1) })
