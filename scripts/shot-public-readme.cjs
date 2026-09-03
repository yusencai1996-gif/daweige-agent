// 开源 README 截图:空数据环境,4 张,1440x900,输出到公开快照目录
const { _electron: electron } = require('playwright')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const OUT = 'F:/xiaokong-projects/daweige-public-snapshot/docs/screenshots'
const EXE = 'F:/xiaokong-projects/daweige-agent/release-v7/win-unpacked/大微阁.exe'

;(async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'dw-shot-'))
  const app = await electron.launch({ executablePath: EXE, env: { ...process.env, DAWEIGE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await win.waitForTimeout(3500)

  // 1) 主界面:空库欢迎页
  await win.screenshot({ path: `${OUT}/main.png` })
  console.log('main ok')

  // 2) 新建角色向导第 1 步(起名;顶部三步指示可见)
  await win.getByRole('button', { name: '＋ 新建角色' }).click()
  await win.waitForTimeout(600)
  await win.screenshot({ path: `${OUT}/wizard.png` })
  // 关掉向导
  await win.getByRole('button', { name: /取消/ }).click().catch(() => {})
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)

  // 3) 设置页:Kimi 面板(key 区+模型区)
  await win.getByText('设置', { exact: true }).click()
  await win.waitForTimeout(900)
  await win.screenshot({ path: `${OUT}/settings.png` })
  console.log('settings ok')

  // 4) 使用统计(空骨架)
  await win.getByText('使用统计', { exact: true }).click()
  await win.waitForTimeout(1200)
  await win.screenshot({ path: `${OUT}/usage.png` })
  console.log('usage ok')

  await app.close()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  console.log('all done')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
