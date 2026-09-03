// 0.4.0 D 批 UI 截图:协作链族谱四连拍(宽屏 DAG/窄屏单列/链摘要卡/打断确认)
// 前置:npm run dev:renderer 已在 5199;用法:node scripts/shot-v040-d1.cjs
const { chromium } = require('playwright')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')

const BASE = 'http://localhost:5199'
const OUT_DIR = path.resolve(__dirname, '../docs/screenshots/v040-d1')

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'chromium' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  let failed = false
  page.on('pageerror', (err) => {
    failed = true
    console.error('[pageerror]', err.message)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      failed = true
      console.error('[console.error]', msg.text())
    }
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // 确保小柊会话打开(bootstrap 默认就是它)
  const mgrSession = page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })
  if (!(await mgrSession.isVisible().catch(() => false))) {
    await page.locator('.manager-card .role-card-title').click()
  }
  await mgrSession.click({ position: { x: 12, y: 10 } })
  const completed = page.locator('.delegation-card', { hasText: '账房干完了' })
  await expectVisible(completed)

  // 1) 宽屏 DAG(1280):详情页顶部协作链族谱
  await completed.getByRole('button', { name: '查看完整过程' }).click()
  const graphBlock = page.locator('.run-graph')
  await expectVisible(graphBlock.getByText(/2 节点/))
  // 纯水平线段 bbox 高为 0,Playwright 视作 hidden;按 attached 判断即可
  await page.locator('.run-graph-wire.handoff').first().waitFor({ state: 'attached' })
  // 挪两下让字号稳定(resize observer 重测)
  await page.waitForTimeout(300)
  await page.screenshot({
    path: path.join(OUT_DIR, 'd1-graph-wide-1280.png'),
    fullPage: false,
  })
  console.log('shot 1 ok: d1-graph-wide-1280.png')

  // 2) 窄屏单列(720):拓扑序列表 + 「来自:账房」文字行
  await page.setViewportSize({ width: 720, height: 900 })
  await expectVisible(page.locator('.run-graph-list'))
  await expectVisible(page.locator('.run-item-upstream', { hasText: '来自:账房(交棒)' }))
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(OUT_DIR, 'd1-graph-narrow-720.png'), fullPage: false })
  console.log('shot 2 ok: d1-graph-narrow-720.png')

  // 回到聊天页
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.getByRole('button', { name: '‹ 返回小柊' }).click()
  await expectVisible(completed)

  // 3) 链摘要卡:卡头一行摘要 + 点开轻量浮层(两位伙伴)
  await completed.getByRole('button', { name: /协作链 2 节点/ }).click()
  await expectVisible(page.locator('.delegation-chain-pop'))
  await page.waitForTimeout(150)
  await page.screenshot({
    path: path.join(OUT_DIR, 'd1-delegation-chain-card.png'),
    fullPage: false,
  })
  console.log('shot 3 ok: d1-delegation-chain-card.png')

  // 4) 打断确认:非终态的小编卡点「打断」出确认文案(mock 种子态是 awaiting,同样非终态可撤)
  await page.locator('.delegation-chain-pop').waitFor({ state: 'hidden' }).catch(() => {})
  await completed.getByRole('button', { name: /协作链 2 节点/ }).click() // 收起浮层
  // 用状态短语定位,避免「:has(btn-interrupt)」在按钮换成确认行后失配
  const interruptible = page.locator('.delegation-card', { hasText: '要不要派给小编' })
  await expectVisible(interruptible)
  await interruptible.getByRole('button', { name: '打断', exact: true }).click()
  await expectVisible(interruptible.getByText('确定打断?已完成的产出保留,未完成的不再继续'))
  await page.waitForTimeout(150)
  await page.screenshot({
    path: path.join(OUT_DIR, 'd1-interrupt-confirm.png'),
    fullPage: false,
  })
  console.log('shot 4 ok: d1-interrupt-confirm.png')

  await browser.close()
  if (failed) {
    console.error('页面有报错,截图可能不干净,请排查。')
    process.exit(1)
  }
  console.log('全部截图完成 →', OUT_DIR)
}

async function expectVisible(locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 8000 })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
