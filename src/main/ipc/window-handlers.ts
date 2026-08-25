import { BrowserWindow } from 'electron'
import { registerHandler } from './handler'

/**
 * 窗口控制 handler(验收反馈:自绘标题栏后系统蓝边框去除)。
 * 安全:统一走 IPC Gate 的 sender 校验;只操作发起调用的窗口本身,
 * 不接受任何窗口标识参数(渲染进程不可信,不能指定别的窗口)。
 */

export function registerWindowHandlers(): void {
  registerHandler('window:minimize', async (_payload, event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  registerHandler('window:toggleMaximize', async (_payload, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  registerHandler('window:close', async (_payload, event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
