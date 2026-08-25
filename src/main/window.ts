import { BrowserWindow } from 'electron'
import { join } from 'node:path'

/**
 * 安全窗口(M2-01)。
 * 铁律:contextIsolation / nodeIntegration:false / sandbox:true;
 * 禁止任意导航、新窗口、webview;渲染进程只能通过 preload 桥通信。
 */

/** dev 模式下 electron-vite 注入的渲染进程 dev server 地址。 */
const devServerUrl: string | undefined = process.env.ELECTRON_RENDERER_URL

/** 生产构建的应用入口(唯一可信页面;预计算小写规范化形态用于比对)。 */
const prodEntryPath = join(__dirname, '../renderer/index.html')

/**
 * 只允许加载我们自己的页面:
 * - dev:精确等于 dev server 地址;
 * - prod:精确等于 out/renderer/index.html(绝不接受任意 file://*.html)。
 * 独立成纯函数便于单测。
 */
export function isAllowedNavigationUrl(url: string): boolean {
  if (devServerUrl && url === devServerUrl) return true
  return (
    url.toLowerCase() === `file:///${prodEntryPath.replace(/\\/g, '/').toLowerCase()}` ||
    url.toLowerCase() === `file://${prodEntryPath.replace(/\\/g, '/').toLowerCase()}`
  )
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // 自绘水墨标题栏:隐藏系统标题栏(验收反馈:系统蓝边框与宣纸风冲突)
    titleBarStyle: 'hidden',
    backgroundColor: '#f3eee2', // 宣纸底,避免启动白闪
    title: '大微阁',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: Boolean(devServerUrl), // 开发期才开;生产构建不暴露
    },
  })

  // 禁止任何新窗口/webview
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // 只允许应用内导航
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url)) event.preventDefault()
  })

  win.on('ready-to-show', () => win.show())

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
