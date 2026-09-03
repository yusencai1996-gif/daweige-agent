import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ContractChannel, RequestOf, ResponseOf } from '../../shared/ipc/contracts'
import { INVOKE_CHANNELS } from '../../shared/ipc/channels'
import { validateRequest, validateResponse } from '../../shared/ipc/schemas'
import { isIpcErrorPayload, type IpcErrorPayload, type IpcErrorCode } from '../../shared/ipc/errors'
import { redactCommonSecrets } from '../security/redaction'
import { isSenderAllowed } from './validate-sender'

/**
 * IPC 安全注册层(M2-02)。
 * 所有 handler 必须经 registerHandler 注册;installIpcGate 统一挂 ipcMain.handle,
 * 每次调用过四道闸:sender 校验 → 入参 schema 校验 → handler → **response schema 校验**。
 * response 校验在主进程权威层完成(0.7.0:sandbox preload 不能引外部依赖,response 复验从 preload 移至此处)。
 * 未登记通道直接拒绝(渲染进程不可信)。
 */

/** 主进程内部抛出的业务错误。 */
export class IpcError extends Error {
  constructor(
    public readonly payload: IpcErrorPayload,
  ) {
    super(payload.message)
    this.name = payload.code
  }
}

export function ipcError(code: IpcErrorCode, message: string): IpcError {
  return new IpcError({ code, message })
}

type AnyHandler = (payload: never, event: IpcMainInvokeEvent) => Promise<unknown>

const registered = new Map<ContractChannel, AnyHandler>()

export function registerHandler<C extends ContractChannel>(
  channel: C,
  handler: (payload: RequestOf<C>, event: IpcMainInvokeEvent) => Promise<ResponseOf<C>>,
): void {
  if (registered.has(channel)) {
    throw new Error(`IPC 通道 ${channel} 重复注册`)
  }
  registered.set(channel, handler as unknown as AnyHandler)
}

function serializeError(payload: IpcErrorPayload): Error {
  // Electron 会把 Error.message 传给渲染进程;用 JSON 承载 code+中文 message,
  // preload 端 decodeIpcError 还原。
  return new Error(JSON.stringify(payload))
}

export function installIpcGate(): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const handler = registered.get(channel)
      if (!handler) {
        throw serializeError(ipcErrorPayload('EUNKNOWN_CHANNEL', '该功能尚未就绪,请稍后再试'))
      }
      if (!isSenderAllowed(event)) {
        throw serializeError(ipcErrorPayload('EINVALID_SENDER', '请求来源不受信任'))
      }
      const validation = validateRequest(channel, payload)
      if (!validation.ok) {
        throw serializeError(ipcErrorPayload('EINVALID_REQUEST', validation.message))
      }
      try {
        const result = await (
          handler as (p: unknown, e: IpcMainInvokeEvent) => Promise<unknown>
        )(payload, event)
        const responseValidation = validateResponse(channel, result)
        if (!responseValidation.ok) {
          console.error(
            `[ipc:${channel}] response 校验失败:`,
            redactCommonSecrets(responseValidation.message),
          )
          throw new IpcError(
            ipcErrorPayload('EINTERNAL', '出了点问题,请重试;若持续出现请重启应用'),
          )
        }
        return responseValidation.value
      } catch (err) {
        if (err instanceof IpcError) {
          throw serializeError(err.payload)
        }
        // 未知异常:不透出细节,防止内部路径/密钥等信息泄露;日志统一脱敏
        console.error(
          `[ipc:${channel}] 内部错误:`,
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
        throw serializeError(ipcErrorPayload('EINTERNAL', '出了点问题,请重试;若持续出现请重启应用'))
      }
    })
  }
}

/** 退出时卸载(窗口关闭后仍可能有残余调用)。 */
export function uninstallIpcGate(): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registered.clear()
}

function ipcErrorPayload(code: IpcErrorCode, message: string): IpcErrorPayload {
  return { code, message }
}

/** 测试与内部用:当前已注册的通道集合。 */
export function registeredChannels(): Set<string> {
  return new Set<string>(registered.keys())
}

export { isIpcErrorPayload }
