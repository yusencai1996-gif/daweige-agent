// 场景2~7 连贯流程:三步建角色 → 建会话/切换/改名 → 守则编辑 → 会话归档/恢复 → 角色归档/恢复 → 删除角色
// 只操作本次新建的「验收小编」角色,绝不动迁移来的 ceshi 角色。
const path = require('node:path')
const { launchApp, stubChooseDialog, shot, printMainLogs } = require('./roles-accept-lib.cjs')

const ROLE_NAME = '验收小编'
const WORKSPACE = path.resolve(__dirname, '..', '.accept-tmp', '测试稿件库')
const results = []
function record(name, ok, note = '') {
  results.push({ name, ok, note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' —— ' + note : ''}`)
}

;(async () => {
  const { app, win, mainLogs } = await launchApp()
  try {
    await win.waitForTimeout(6000) // 等迁移/bootstrap
    await stubChooseDialog(app, WORKSPACE)

    // 幂等清理:上次跑挂留下的「验收小编」先走 UI 删除流程清掉(顺带也是删除路径的真实复验)
    let leftover = win.locator('.role-card', { has: win.locator('.role-card-title', { hasText: ROLE_NAME }) })
    if ((await leftover.count()) > 0) {
      console.log('[cleanup] 发现残留「验收小编」,先删一遍')
      await leftover.locator(`button[aria-label="「${ROLE_NAME}」的操作"]`).click()
      await win.waitForTimeout(300)
      await win.getByRole('menuitem', { name: '删除', exact: true }).click()
      await win.waitForTimeout(1500)
      await win.locator('#delete-confirm-name').fill(ROLE_NAME)
      await win.locator('.role-dialog').getByText('彻底删除', { exact: true }).click()
      await win.waitForTimeout(1500)
      console.log('[cleanup] 残留角色已删')
    }

    /* ---------- 场景2:三步建角色 ---------- */
    await win.getByText('＋ 新建角色', { exact: true }).click()
    await win.waitForTimeout(500)
    const nameInput = win.locator('#wizard-name')
    await nameInput.fill('字'.repeat(25)) // 25 字
    const len25 = await nameInput.inputValue()
    record('S2 起名 25 字被拦在 24', len25.length === 24, `实际 ${len25.length} 字`)
    await shot(win, 'roles-s2-step1-name-limit.png')

    await nameInput.fill(ROLE_NAME)
    await win.getByText('下一步', { exact: true }).click()
    await win.waitForTimeout(400)

    await win.getByText('选择文件夹…', { exact: true }).click()
    await win.waitForTimeout(600)
    const wsName = await win.locator('.wizard-workspace-name').textContent().catch(() => null)
    record('S2 选中文件夹并显示末级目录名', wsName === '测试稿件库', `显示=${wsName}`)
    await shot(win, 'roles-s2-step2-workspace.png')
    await win.getByText('下一步', { exact: true }).click()
    await win.waitForTimeout(1200) // 拉模板

    const tplCount = await win.locator('.wizard-tpl').count()
    record('S2 四个模板卡', tplCount === 4, `实际 ${tplCount}`)
    await win.locator('.wizard-tpl', { hasText: '写稿助手' }).click()
    await win.waitForTimeout(300)
    const guardrails = win.locator('.wizard-guardrails')
    const draftLen = (await guardrails.inputValue()).length
    record('S2 选模板后守则草稿自动填入', draftLen > 0, `草稿 ${draftLen} 字`)
    await guardrails.fill((await guardrails.inputValue()) + '\n验收追加:草稿可以直接改。')
    const countText = await win.locator('.wizard-count').textContent()
    record('S2 字数计数显示', /\d+ \/ 推荐 2000 \/ 上限 6000/.test(countText), countText.trim())
    await shot(win, 'roles-s2-step3-template.png')

    await win.getByText('招他入伙', { exact: true }).click()
    await win.waitForTimeout(1500)
    const newCard = win.locator('.role-card', { has: win.locator('.role-card-title', { hasText: ROLE_NAME }) })
    const cardVisible = (await newCard.count()) === 1
    const expanded = cardVisible && (await newCard.locator('.role-card-title').getAttribute('aria-expanded')) === 'true'
    const hasChatBtn = cardVisible && (await newCard.getByText('和他聊聊', { exact: true }).count()) === 1
    record('S2 卡片上墙并展开+空态「和他聊聊」', cardVisible && expanded && hasChatBtn,
      `卡=${cardVisible} 展开=${expanded} 按钮=${hasChatBtn}`)
    await shot(win, 'roles-s2-created.png')

    /* ---------- 场景3:建会话/切换/改名 ---------- */
    await newCard.getByText('和他聊聊', { exact: true }).click()
    await win.waitForTimeout(1500)
    let body = await win.textContent('body')
    record('S3 建会话1→聊天区空态', body.includes('这还是个空会话'))
    const sessRows = newCard.locator('.session-item')
    record('S3 会话1出现在角色卡下', (await sessRows.count()) === 1)

    await newCard.getByText('＋ 新会话', { exact: true }).click()
    await win.waitForTimeout(1500)
    record('S3 建会话2', (await sessRows.count()) === 2, `实际 ${await sessRows.count()}`)
    const title2 = (await sessRows.nth(0).locator('.session-title').textContent()).trim()

    // 切换到会话1(点行左侧文字区,避开右侧 hover 操作)
    await sessRows.nth(1).click({ position: { x: 30, y: 16 } })
    await win.waitForTimeout(1200)
    const switchedActive = await sessRows.nth(1).getAttribute('class')
    const otherActive = await sessRows.nth(0).getAttribute('class')
    record('S3 两个会话互不串(切换生效)', (switchedActive ?? '').includes('active') && !(otherActive ?? '').includes('active'),
      `行1=${switchedActive} 行0=${otherActive}`)
    await shot(win, 'roles-s3-two-sessions.png')

    // 行内改名会话1(hover 行左侧,操作按钮 aria-label 定位)
    const row1Wrap = sessRows.nth(1).locator('..')
    await sessRows.nth(1).hover({ position: { x: 8, y: 8 } })
    await win.waitForTimeout(300)
    await row1Wrap.getByRole('button', { name: '改名', exact: true }).click()
    await win.waitForTimeout(300)
    const renameInput = newCard.locator('.rename-input')
    await renameInput.fill('改名验收会话')
    await renameInput.press('Enter')
    await win.waitForTimeout(1000)
    const renamed = (await newCard.locator('.session-item.active .session-title').textContent()).trim()
    record('S3 行内改名生效', renamed === '改名验收会话', `当前=${renamed}`)
    await shot(win, 'roles-s3-renamed.png')

    /* ---------- 场景4:守则编辑 ---------- */
    await newCard.locator(`button[aria-label="「${ROLE_NAME}」的操作"]`).click()
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: '编辑守则' }).click()
    await win.waitForTimeout(1500)
    body = await win.textContent('body')
    const rulesLoaded = body.includes(`${ROLE_NAME} 的守则`)
    record('S4 守则页加载(标题=角色名)', rulesLoaded)
    const rulesArea = win.locator('.rules-textarea')
    await rulesArea.fill((await rulesArea.inputValue()) + '\n验收追加一条:回话先报数。')
    const rulesCount = await win.locator('.rules-count').textContent()
    record('S4 守则字数计数显示', /\d+ \/ 推荐 2000 \/ 上限 6000/.test(rulesCount), rulesCount.trim())
    await shot(win, 'roles-s4-rules-editing.png')
    await win.locator('.rules-header').getByText('保存', { exact: true }).click()
    await win.waitForTimeout(1200)
    const notice = await win.locator('.sidebar-notice').textContent()
    record('S4 保存后提示「守则已更新」', (notice ?? '').includes('守则已更新'), (notice ?? '').trim())
    await win.getByText('‹ 返回', { exact: true }).click()
    await win.waitForTimeout(600)

    /* ---------- 场景5:会话归档/恢复 ---------- */
    const rowToArchive = newCard.locator('.session-item', { hasText: title2 })
    await rowToArchive.hover({ position: { x: 8, y: 8 } })
    await win.waitForTimeout(300)
    await rowToArchive.locator('..').getByRole('button', { name: '归档', exact: true }).click()
    await win.waitForTimeout(1200)
    record('S5 会话归档后主列表消失', (await newCard.locator('.session-item').count()) === 1,
      `剩 ${await newCard.locator('.session-item').count()} 条`)
    const archiveEntry = await win.locator('.archive-entry').textContent()
    record('S5 侧栏归档入口计数+1', /归档\s*1/.test(archiveEntry ?? ''), (archiveEntry ?? '').trim())
    await win.locator('.archive-entry').click()
    await win.waitForTimeout(800)
    await win.getByRole('tab', { name: /会话/ }).click()
    await win.waitForTimeout(400)
    body = await win.textContent('body')
    record('S5 归档区会话页签可见该会话', body.includes(title2))
    await shot(win, 'roles-s5-archive-sessions-tab.png')
    await win.locator('.archive-row', { hasText: title2 }).getByText('恢复', { exact: true }).click()
    await win.waitForTimeout(1200)
    await win.getByText('‹ 返回', { exact: true }).click()
    await win.waitForTimeout(800)
    record('S5 恢复后回主列表', (await newCard.locator('.session-item').count()) === 2)

    /* ---------- 场景6:角色归档/恢复(带独立归档会话) ---------- */
    // 先独立归档会话2,再归档角色,验证恢复角色后它仍留归档区
    await newCard.locator('.session-item', { hasText: title2 }).hover({ position: { x: 8, y: 8 } })
    await win.waitForTimeout(300)
    await newCard.locator('.session-item', { hasText: title2 }).locator('..').getByRole('button', { name: '归档', exact: true }).click()
    await win.waitForTimeout(1000)
    await newCard.locator(`button[aria-label="「${ROLE_NAME}」的操作"]`).click()
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: '归档', exact: true }).click()
    await win.waitForTimeout(1200)
    record('S6 角色归档后整卡消失', (await newCard.count()) === 0)
    const archiveEntry2 = await win.locator('.archive-entry').textContent()
    // 语义:独立归档会话的角色已归档时,会话随角色隐藏不重复计数 → 1角色+0独立会话=1
    record('S6 归档入口=1(角色归档后其归档会话不重复计)', /归档\s*1/.test(archiveEntry2 ?? ''), (archiveEntry2 ?? '').trim())
    await shot(win, 'roles-s6-role-archived.png')

    await win.locator('.archive-entry').click()
    await win.waitForTimeout(800)
    body = await win.textContent('body')
    record('S6 归档区角色页签可见', body.includes(ROLE_NAME))
    await shot(win, 'roles-s6-archive-roles-tab.png')
    await win.locator('.archive-row', { hasText: ROLE_NAME }).getByText('恢复', { exact: true }).click()
    await win.waitForTimeout(1200)
    record('S6 恢复角色后卡片回来', (await newCard.count()) === 1)
    await win.getByRole('tab', { name: /会话/ }).click()
    await win.waitForTimeout(400)
    body = await win.textContent('body')
    record('S6 恢复角色后独立归档会话仍留归档区', body.includes(title2))
    await shot(win, 'roles-s6-independent-session-stays.png')
    // 顺手恢复该会话,为删除场景留干净现场
    await win.locator('.archive-row', { hasText: title2 }).getByText('恢复', { exact: true }).click()
    await win.waitForTimeout(1000)
    await win.getByText('‹ 返回', { exact: true }).click()
    await win.waitForTimeout(800)

    /* ---------- 场景7:角色删除 ---------- */
    await newCard.locator('.role-card-title').click() // 确保展开
    await win.waitForTimeout(500)
    await newCard.locator(`button[aria-label="「${ROLE_NAME}」的操作"]`).click()
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: '删除', exact: true }).click()
    await win.waitForTimeout(1500)
    body = await win.textContent('body')
    const impactOk = body.includes(`彻底删除「${ROLE_NAME}」`) && body.includes('个会话')
      && body.includes('角色档案目录') && body.includes('使用统计保留')
    record('S7 影响清单完整(名字/会话数/家目录/固定文案)', impactOk)
    await shot(win, 'roles-s7-delete-impact.png')

    const confirmInput = win.locator('#delete-confirm-name')
    await confirmInput.fill('错误名字')
    await win.waitForTimeout(200)
    const delBtn = win.locator('.role-dialog').getByText('彻底删除', { exact: true })
    record('S7 错名时删除按钮禁用', await delBtn.isDisabled())
    await confirmInput.fill(ROLE_NAME)
    await win.waitForTimeout(200)
    record('S7 输对名字后按钮放行', !(await delBtn.isDisabled()))
    await delBtn.click()
    await win.waitForTimeout(1500)
    record('S7 删除后卡片消失', (await newCard.count()) === 0)
    body = await win.textContent('body')
    // title2 是「新会话」这种通用词(别的卡片按钮也有),只验证改过的独特名字与角色名下无残留会话行
    const leftoverRows = await win.locator('.session-item', { hasText: '改名验收会话' }).count()
    record('S7 会话一并消失(列表无残留)', !body.includes('改名验收会话') && leftoverRows === 0)
    await shot(win, 'roles-s7-deleted.png')

    /* ---------- 汇总 ---------- */
    console.log('\n========== 汇总 ==========')
    const fails = results.filter((r) => !r.ok)
    console.log(`共 ${results.length} 项,过 ${results.length - fails.length},不过 ${fails.length}`)
    printMainLogs(mainLogs, 's2~s7 流程')
    if (fails.length > 0) process.exit(2)
  } finally {
    await app.close()
  }
})().catch((e) => {
  console.error('S2~S7 脚本异常:', e)
  process.exit(1)
})
