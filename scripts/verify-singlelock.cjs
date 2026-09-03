// 双实例验证:第一实例常驻,第二实例应秒退且无原生弹窗(退出码 0)
const { _electron: electron } = require('playwright')
const { spawn } = require('node:child_process')
const exe = 'F:/xiaokong-projects/daweige-agent/release-v7/win-unpacked/大微阁.exe'
;(async () => {
  const first = await electron.launch({ executablePath: exe })
  const win = await first.firstWindow()
  await win.waitForTimeout(2500)
  console.log('first instance ok')
  // 直接 spawn 第二实例(带独立 userData,模拟 E2E/截图场景)
  // 同 userData 双开(用户双击两次图标的场景):应命中单实例锁秒退
  const second = spawn(exe, [], { stdio: 'pipe' })
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('TIMEOUT_10s'), 10000)
    second.on('exit', (c) => { clearTimeout(t); resolve(c) })
  })
  console.log('second instance exit =', code)
  await first.close()
  process.exit(code === 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
