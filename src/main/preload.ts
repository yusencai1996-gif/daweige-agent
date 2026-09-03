import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isInvokeChannel, PUSH_CHANNELS } from '../shared/ipc/channels'
import { isIpcErrorPayload } from '../shared/ipc/errors'
import type { DaweigeBridge } from '../shared/ipc/bridge'
import type { ContractChannel, RequestOf, ResponseOf } from '../shared/ipc/contracts'
import type { AgentPushEvent } from '../shared/ipc/events'

/**
 * preload 桥(M2-01/02)。
 * sandbox:true 下仅可用 ipcRenderer/contextBridge;**必须自包含零外部依赖**
 * (0.7.0 实踩:sandbox preload 不能 require node_modules,引 @sinclair/typebox 导致
 * preload 整体加载失败白屏——response 校验移至主进程 IPC Gate,handler.ts 权威层复验)。
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

const invoke = async <C extends ContractChannel>(
  channel: C,
  payload: RequestOf<C>,
): Promise<ResponseOf<C>> => {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`未知通道:${channel}`))
    }
    try {
      return await ipcRenderer.invoke(channel, payload) as ResponseOf<C>
    } catch (err) {
      throw decodeIpcError(err)
    }
}

const bridge = {
  invoke,
  onAgentEvent: (listener: (event: AgentPushEvent) => void): (() => void) => {
    const channel = PUSH_CHANNELS[0]
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      // 技能审批事件的合法性由主进程 ApprovalBroker 构造侧保证(强类型+schema);
      // preload 不做校验(无外部依赖红线),只透传。
      listener(payload as AgentPushEvent)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
} satisfies DaweigeBridge

contextBridge.exposeInMainWorld('daweige', bridge)

export type DaweigeWindowBridge = typeof bridge
