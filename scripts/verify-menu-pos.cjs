const { _electron: electron } = require('playwright')
;(async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const win = await app.firstWindow()
  await win.waitForTimeout(3000)
  // 展开第一个角色卡(手风琴默认收起,会话行不渲染)
  const head = win.locator('.role-card .role-card-head').first()
  const row0 = win.locator('.session-item').first()
  if ((await row0.count()) === 0) {
    await head.click()
    await win.waitForTimeout(400)
  }
  // 取列表中部的行(首行上方空间不足会合理回退向下;中部行应向上展开)
  const rowCount = await win.locator('.session-item').count()
  const row = win.locator('.session-item').nth(Math.min(1, rowCount - 1))
  await row.hover({ position: { x: 8, y: 8 } })
  await win.waitForTimeout(400)
  const btn = row.locator('..').locator('.session-menu-btn')
  await btn.click()
  await win.waitForTimeout(400)
  const overlap = await win.evaluate(() => {
    const menu = document.querySelector('.session-menu')
    const newBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('新会话'))
    if (!menu || !newBtn) return { found: false }
    const a = menu.getBoundingClientRect()
    const b = newBtn.getBoundingClientRect()
    const menuRow = document.querySelector('.session-menu')?.parentElement
    const r = menuRow?.getBoundingClientRect()
    return {
      found: true,
      overlap: a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right,
      opensUpward: r ? a.bottom <= r.bottom + 2 : false,
      menuBottom: Math.round(a.bottom),
      newBtnTop: Math.round(b.top),
      rowBottom: r ? Math.round(r.bottom) : -1,
    }
  })
  console.log(JSON.stringify(overlap))
  await win.screenshot({ path: 'docs/design/acceptance-check/a11-menu-position.png' })
  await app.close()
  process.exit(overlap.found && (overlap.opensUpward || !overlap.overlap) ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
