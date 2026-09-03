import { registerHandler, ipcError } from './handler'
import {
  ApprovalNotFoundError,
  ApprovalResponseMismatchError,
  type ApprovalBroker,
} from '../agent/approval-broker'

/** 确认响应 IPC(M4-02)。 */

export function registerApprovalHandlers(broker: ApprovalBroker): void {
  registerHandler('approval:respond', async (response) => {
    try {
      broker.resolve(response)
    } catch (err) {
      if (err instanceof ApprovalNotFoundError) {
        throw ipcError('EAPPROVAL_NOT_FOUND', '这张确认卡已失效(可能已处理或已超时),无需重复操作')
      }
      if (err instanceof ApprovalResponseMismatchError) {
        throw ipcError('EINVALID_REQUEST', '这次确认与卡片内容不匹配,已拒绝处理')
      }
      throw err
    }
  })
}
