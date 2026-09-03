// 场景8:mount missing 真机行为链 —— 建角色挂真实目录 → 关 app 挪走目录 → 重启看警示 → 点「和他聊聊」看后果
// 已知疑点:availability 只在创建/迁移时打标,读路径不重新 stat;本脚本如实记录真机表现。
// legacy-unresolved:dev 库两条旧会话 cwd 均有效,无此数据,UI 行为由 mock 预览测试覆盖。
const path = require('node:path')
const fs = require('node:fs')
const { launchApp, stubChooseDialog, shot, printMainLogs } = require('./roles-accept-lib.cjs')

const ROLE_NAME = '临逝伙计'
const DIR = path.resolve(__dirname, '..', '.accept-tmp', '即将消失的目录')
const DIR_AWAY = DIR + '_挪走了'

async function launchAndWait() {
  const ctx = await launchApp()
  await ctx.win.waitForTimeout(5000)
  return ctx
}

async function deleteRoleViaUi(win) {
  const card = win.locator('.role-card', { has: win.locator('.role-card-title', { hasText: ROLE_NAME }) })
  if ((await card.count()) === 0) return false
  await card.locator(`button[aria-label="「${ROLE_NAME}」的操作"]`).click()
  await win.waitForTimeout(300)
  await win.getByRole('menuitem', { name: '删除', exact: true }).click()
  await win.waitForTimeout(1500)
  await win.locator('#delete-confirm-name').fill(ROLE_NAME)
  await win.locator('.role-dialog').getByText('彻底删除', { exact: true }).click()
  await win.waitForTimeout(1500)
  return true
}

;(async () => {
  // 归位:若上次中断目录在挪走态,先挪回
  if (fs.existsSync(DIR_AWAY) && !fs.existsSync(DIR)) fs.renameSync(DIR_AWAY, DIR)
  fs.mkdirSync(DIR, { recursive: true })

  // 1. 建角色(真实存在的目录)
  let ctx = await launchAndWait()
  try {
    await stubChooseDialog(ctx.app, DIR)
    await deleteRoleViaUi(ctx.win)
    await ctx.win.getByText('＋ 新建角色', { exact: true }).click()
    await ctx.win.locator('#wizard-name').fill(ROLE_NAME)
    await ctx.win.getByText('下一步', { exact: true }).click()
    await ctx.win.getByText('选择文件夹…', { exact: true }).click()
    await ctx.win.waitForTimeout(500)
    await ctx.win.getByText('下一步', { exact: true }).click()
    await ctx.win.waitForTimeout(1200)
    await ctx.win.locator('.wizard-tpl', { hasText: '记事本' }).click()
    await ctx.win.getByText('招他入伙', { exact: true }).click()
    await ctx.win.waitForTimeout(1500)
    const ok = (await ctx.win.locator('.role-card-title', { hasText: ROLE_NAME }).count()) === 1
    console.log('1. 建角色 =', ok ? 'OK' : 'FAIL')
    if (!ok) throw new Error('建角色失败,中止')
  } finally {
    await ctx.app.close()
  }

  // 2. 挪走目录,重启
  fs.renameSync(DIR, DIR_AWAY)
  ctx = await launchAndWait()
  try {
    const card = ctx.win.locator('.role-card', { has: ctx.win.locator('.role-card-title', { hasText: ROLE_NAME }) })
    const warnCount = await card.locator('.role-mount-warning').count()
    console.log('2. 目录挪走后重启,警示图标 =', warnCount === 1 ? 'OK(出现)' : `未出现(数量 ${warnCount})——读路径不刷新 availability`)
    // 重启后手风琴不收起状态不持久,先点开卡
    await card.locator('.role-card-title').click()
    await ctx.win.waitForTimeout(500)
    await shot(ctx.win, 'roles-s8-after-dir-gone.png')

    // 3. 点「和他聊聊」看后果(真机:availability 是创建时的快照,后端会不会拦?)
    await card.getByText('和他聊聊', { exact: true }).click()
    await ctx.win.waitForTimeout(2000)
    const notice = await ctx.win.locator('.sidebar-notice').textContent()
    const sessionCount = await card.locator('.session-item').count()
    const dirRecreated = fs.existsSync(DIR)
    console.log('3. missing 角色建会话:提示 =', (notice ?? '').trim() || '(无)', '| 会话数 =', sessionCount, '| 目录被自动重建 =', dirRecreated)
    await shot(ctx.win, 'roles-s8-missing-create-attempt.png')
  } finally {
    await ctx.app.close()
  }

  // 4. 还原现场:目录挪回(若被 app 自动重建则不覆盖,汇报说明)
  if (fs.existsSync(DIR_AWAY) && !fs.existsSync(DIR)) {
    fs.renameSync(DIR_AWAY, DIR)
    console.log('4. 目录已挪回原名')
  } else if (fs.existsSync(DIR_AWAY) && fs.existsSync(DIR)) {
    console.log('4. 注意:目录被 app 重建过,挪走的那份留在', DIR_AWAY, '(未删任何文件,需人工合并)')
  }

  // 5. 重启清理:删角色(级联删本次产生的会话)
  ctx = await launchAndWait()
  try {
    const deleted = await deleteRoleViaUi(ctx.win)
    console.log('5. 清理删角色 =', deleted ? 'OK' : '(无残留)')
    printMainLogs(ctx.mainLogs, 's8 清理')
  } finally {
    await ctx.app.close()
  }
})().catch((e) => {
  console.error('S8 脚本异常:', e)
  try {
    if (fs.existsSync(DIR_AWAY) && !fs.existsSync(DIR)) fs.renameSync(DIR_AWAY, DIR)
  } catch {}
  process.exit(1)
})
