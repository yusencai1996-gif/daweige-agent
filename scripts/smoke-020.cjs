// 0.2.0 安装产物冒烟:起 unpacked 版,验证启动+侧栏渲染,截图
const { _electron: electron } = require('playwright')

;(async () => {
  const app = await electron.launch({
    executablePath: 'F:/xiaokong-projects/daweige-agent/release-v5/win-unpacked/大微阁.exe',
  })
  const win = await app.firstWindow()
  await win.waitForTimeout(4000)
  const title = await win.title()
  const body = await win.textContent('body').catch(() => '')
  const ok = body.includes('大微阁') || body.includes('新建角色') || body.includes('小柊')
  console.log('title =', title)
  console.log('launch ok =', ok)
  await win.screenshot({
    path: 'F:/xiaokong-projects/daweige-agent/docs/design/acceptance-check/roles-020-installed-smoke.png',
  })
  await app.close()
  process.exit(ok ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
