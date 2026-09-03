// 场景1:启动 + 老会话迁移归组
// 预期:dev 库 2 条旧会话(cwd=D:\ceshi,文件夹存在)→ 归组为角色卡「ceshi」,展开见 2 条会话
const { launchApp, shot, printMainLogs } = require('./roles-accept-lib.cjs')

;(async () => {
  const { app, win, mainLogs } = await launchApp()
  try {
    await win.waitForTimeout(2500)
    // 迁移是启动后异步跑的,多等一会儿
    await win.waitForTimeout(4000)

    const body = await win.textContent('body')
    console.log('侧栏含「ceshi」角色卡 =', body.includes('ceshi'))
    console.log('侧栏含「归档」入口 =', body.includes('归档'))

    // 点开 ceshi 角色卡(若未自动展开)
    const cardTitle = win.locator('.role-card-title', { hasText: 'ceshi' })
    console.log('ceshi 卡头数量 =', await cardTitle.count())
    if ((await cardTitle.count()) > 0) {
      const expanded = await cardTitle.first().getAttribute('aria-expanded')
      console.log('ceshi 卡 aria-expanded =', expanded)
      if (expanded !== 'true') {
        await cardTitle.first().click()
        await win.waitForTimeout(600)
      }
    }

    const card = win.locator('.role-card', { has: win.locator('.role-card-title', { hasText: 'ceshi' }) })
    const sessionItems = card.locator('.session-item')
    const n = await sessionItems.count()
    console.log('ceshi 卡下会话数 =', n)
    for (let i = 0; i < n; i += 1) {
      console.log(`  会话${i + 1}:`, (await sessionItems.nth(i).textContent()).trim())
    }
    console.log('卡头元信息 =', (await card.locator('.role-card-meta').textContent().catch(() => '')).trim())

    await shot(win, 'roles-s1-boot-grouping.png')

    // 打开第一条旧会话,确认能回看(点行左侧文字区,避开右侧 hover 操作按钮)
    if (n > 0) {
      await sessionItems.first().click({ position: { x: 30, y: 16 } })
      await win.waitForTimeout(1500)
      await shot(win, 'roles-s1-open-legacy-session.png')
      const body2 = await win.textContent('body')
      console.log('打开旧会话后聊天区有内容/空态 =', body2.includes('空会话') ? '空会话' : '有消息或加载中')
    }

    printMainLogs(mainLogs, 's1 启动+迁移')
  } finally {
    await app.close()
  }
})().catch((e) => {
  console.error('S1 脚本异常:', e)
  process.exit(1)
})
