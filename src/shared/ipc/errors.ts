/**
 * IPC 错误码与错误负载。
 * message 为中文、可直接展示给用户;主进程负责把底层错误翻译成这里的人话。
 */

export type IpcErrorCode =
  | 'EINVALID_REQUEST' // 入参未通过 schema 校验
  | 'EUNKNOWN_CHANNEL' // 未登记的通道
  | 'EINVALID_SENDER' // 非法 sender frame
  | 'ESESSION_NOT_FOUND' // 会话不存在或已删除
  | 'ESESSION_BUSY' // 会话正在回复/有待确认卡,归档等操作被拒
  | 'EROLE_CONFLICT' // 守则版本过期(保存守则/写守则工具的乐观并发冲突)
  | 'EROLE_DELETE_CONFLICT' // 删除确认过期(影响清单已变/输名不一致),需重新确认
  | 'EAPPROVAL_NOT_FOUND' // 确认 ID 伪造 / 重复响应 / 已过期
  | 'EPROVIDER_NOT_CONFIGURED' // 该厂商未配置 key
  | 'ECONNECTIVITY_FAILED' // 连通测试失败(含错误 key / 网络)
  | 'EAGENT_BUSY' // 当前会话正在回复,重复发送被拒
  | 'EINTERNAL' // 主进程内部错误(不透出细节)

export interface IpcErrorPayload {
  readonly code: IpcErrorCode
  /** 中文错误信息,可直接展示。 */
  readonly message: string
}

export function isIpcErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  const message = (value as { message?: unknown }).message
  return typeof code === 'string' && typeof message === 'string'
}
