// 场景9:视觉与响应式四档截图(1440/1024/760/640)+ 760 以下抽屉开合
// 窗口 minWidth=960,760/640 两档运行时临时放宽最小尺寸截完恢复(不改代码)。
const { launchApp, shot, printMainLogs } = require('./roles-accept-lib.cjs')

;(async () => {
  const { app, win, mainLogs } = await launchApp()
  try {
    await win.waitForTimeout(5000)
    // 确保有一张卡展开着(点开 ceshi)
    const cardTitle = win.locator('.role-card-title', { hasText: 'ceshi' })
    if ((await cardTitle.count()) > 0) {
      const expanded = await cardTitle.first().getAttribute('aria-expanded')
      if (expanded !== 'true') await cardTitle.first().click()
    }
    await win.waitForTimeout(500)

    const setSize = async (w, h) =>
      app.evaluate(({ BrowserWindow }, [ww, hh]) => {
        BrowserWindow.getAllWindows()[0].setSize(ww, hh)
      }, [w, h])
    const setMin = async (w, h) =>
      app.evaluate(({ BrowserWindow }, [ww, hh]) => {
        BrowserWindow.getAllWindows()[0].setMinimumSize(ww, hh)
      }, [w, h])

    // 桌面两档(最小尺寸够得着)
    for (const w of [1440, 1024]) {
      await setSize(w, 840)
      await win.waitForTimeout(600)
      await shot(win, `roles-s9-${w}.png`)
      const sidebarVisible = await win.locator('aside.sidebar').isVisible()
      const menuBtnVisible = await win.locator('.main-pane .menu-btn').first().isVisible().catch(() => false)
      console.log(`${w}px: 侧栏常驻=${sidebarVisible} 抽屉按钮=${menuBtnVisible}`)
    }

    // 窄档:临时放宽最小尺寸
    await setMin(400, 480)
    for (const w of [760, 640]) {
      await setSize(w, 840)
      await win.waitForTimeout(600)
      await shot(win, `roles-s9-${w}.png`)
      const menuBtnVisible = await win.locator('.main-pane .menu-btn').first().isVisible().catch(() => false)
      console.log(`${w}px: 抽屉按钮可见=${menuBtnVisible}`)
    }

    // 640px 抽屉开合:点 .menu-btn 开 → 点遮罩关
    const menuBtn = win.locator('.main-pane .menu-btn').first()
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click()
      await win.waitForTimeout(500)
      const opened = await win.locator('aside.sidebar.open').count()
      console.log('640px 抽屉点开 =', opened === 1 ? 'OK' : 'FAIL')
      await shot(win, 'roles-s9-640-drawer-open.png')
      await win.locator('.sidebar-backdrop').click()
      await win.waitForTimeout(500)
      const closed = (await win.locator('aside.sidebar.open').count()) === 0
      console.log('640px 抽屉点遮罩收起 =', closed ? 'OK' : 'FAIL')
    } else {
      console.log('640px 找不到抽屉按钮 = FAIL')
    }

    // 复原窗口约束
    await setMin(960, 640)
    await setSize(1280, 840)
    printMainLogs(mainLogs, 's9 响应式')
  } finally {
    await app.close()
  }
})().catch((e) => {
  console.error('S9 脚本异常:', e)
  process.exit(1)
})
