import type { IpcMainInvokeEvent } from 'electron'
import { isAllowedNavigationUrl } from '../window'

/**
 * IPC sender 校验(M2-02)。
 * 渲染进程不可信:只接受来自我们窗口主 frame 的调用。
 */

export function isSenderAllowed(event: IpcMainInvokeEvent): boolean {
  // 必须来自主 frame(防 iframe/子 frame 冒充)
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
    return false
  }
  const url = event.senderFrame?.url ?? event.sender.getURL()
  return isAllowedNavigationUrl(url)
}
