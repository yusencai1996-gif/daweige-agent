import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isInvokeChannel, PUSH_CHANNELS } from '../shared/ipc/channels'
import { isIpcErrorPayload } from '../shared/ipc/errors'
import type { AgentPushEvent } from '../shared/ipc/events'

/**
 * preload 桥(M2-01/02)。
 * sandbox:true 下仅可用 ipcRenderer/contextBridge;
 * 双重防线:preload 侧白名单 + 主进程 IPC Gate 校验。
 */

function decodeIpcError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron 会给 ipcMain.handle 抛出的错误加 "Error invoking remote method '<channel>': "
  // 前缀——从整串里容错抽取 JSON 载荷,而不是假设 message 就是纯 JSON。
  try {
    const match = /\{[\s\S]*\}/.exec(raw)
    if (match) {
      const parsed: unknown = JSON.parse(match[0])
      if (isIpcErrorPayload(parsed)) {
        const decoded = new Error(parsed.message)
        decoded.name = parsed.code
        return decoded
      }
    }
  } catch {
    // message 不是 JSON,走兜底
  }
  return new Error('主进程通信异常,请重试')
}

const bridge = {
  invoke: async (channel: string, payload: unknown): Promise<unknown> => {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`未知通道:${channel}`))
    }
    try {
      return await ipcRenderer.invoke(channel, payload)
    } catch (err) {
      throw decodeIpcError(err)
    }
  },
  onAgentEvent: (listener: (event: AgentPushEvent) => void): (() => void) => {
    const channel = PUSH_CHANNELS[0]
    const wrapped = (_event: IpcRendererEvent, agentEvent: AgentPushEvent): void => {
      listener(agentEvent)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('daweige', bridge)

export type DaweigeWindowBridge = typeof bridge
