// 角色化真机验收公共库:启动 Electron、抓主进程日志、截图、stub 系统目录选择器
const path = require('node:path')
const electron = require('playwright')._electron

const ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(ROOT, 'docs', 'design', 'acceptance-check')

/** 启动应用;返回 { app, win, mainLogs }。mainLogs 为主进程 stdout/stderr 累积文本。 */
async function launchApp() {
  const app = await electron.launch({ args: [path.join(ROOT, 'out', 'main', 'index.js')] })
  const logs = []
  const proc = app.process()
  proc.stdout.on('data', (d) => logs.push(`[out] ${String(d).trim()}`))
  proc.stderr.on('data', (d) => logs.push(`[err] ${String(d).trim()}`))
  const win = await app.firstWindow()
  win.on('console', (msg) => {
    if (msg.type() === 'error') logs.push(`[renderer-console-error] ${msg.text()}`)
  })
  win.on('pageerror', (err) => logs.push(`[renderer-pageerror] ${err.message}`))
  return { app, win, mainLogs: logs }
}

/** 把主进程的目录选择对话框 stub 成固定返回 dir(一次性授权仍走真实 grant 流程)。 */
async function stubChooseDialog(app, dir) {
  await app.evaluate(
    ({ dialog }, d) => {
      dialog.__rolesAcceptStub = d
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dialog.__rolesAcceptStub] })
    },
    dir,
  )
}

async function shot(win, name) {
  const p = path.join(SHOT_DIR, name)
  await win.screenshot({ path: p })
  console.log(`[shot] ${name}`)
}

function printMainLogs(logs, label) {
  console.log(`\n===== 主进程日志(${label}) =====`)
  for (const line of logs) console.log(line)
  console.log('===== 日志结束 =====\n')
}

module.exports = { ROOT, SHOT_DIR, launchApp, stubChooseDialog, shot, printMainLogs }
