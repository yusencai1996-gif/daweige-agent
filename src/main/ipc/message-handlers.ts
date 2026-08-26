import { registerHandler, ipcError } from './handler'
import { AgentBusyError, ModelNotReadyError, type AgentService } from '../agent/agent-service'
import { PromptComposerError } from '../agent/prompt-composer'
import { InternalSessionAccessError, SessionCreateError } from '../storage/session-service'
import type { SettingsStore } from '../storage/settings-store'
import { SessionNotFoundError } from '../storage/session-service'
import type { ApprovalBroker } from '../agent/approval-broker'
import type { CredentialStore } from '../security/credential-store'

/**
 * 消息 IPC(M3-04)。
 * message:send 用 settings 里的当前厂商选择(顶部切换已写入 settings)。
 */

export function registerMessageHandlers(
  agentService: AgentService,
  settingsStore: SettingsStore,
  approvalBroker?: ApprovalBroker,
  credentialStore?: CredentialStore,
  sessionService?: import('../storage/session-service').SessionService,
): void {
  registerHandler('message:send', async ({ sessionId, text }) => {
    // 已归档会话兜底拦截(前端已禁输入;万一绕过也不让继续聊,批3初审整改)
    try {
      await sessionService?.assertUserVisibleSession(sessionId)
      await sessionService?.assertSessionNotArchived(sessionId)
    } catch (err) {
      throw mapAgentError(err)
    }
    const settings = await settingsStore.load()
    // A-05:未填 key 直接发消息时,先给人话提示(否则 pi 凭据层英文错误直出)
    const providerId = settings.providerSelection.providerId
    if (credentialStore && !credentialStore.status(providerId).configured) {
      throw ipcError(
        'EPROVIDER_NOT_CONFIGURED',
        '这一家还没填 Key:请点左下角「设置」→ 填好 Key 并测试连通后再发消息。',
      )
    }
    try {
      return await agentService.send(sessionId, text, settings.providerSelection)
    } catch (err) {
      throw mapAgentError(err)
    }
  })

  registerHandler('message:abort', async ({ sessionId }) => {
    try {
      await sessionService?.assertUserVisibleSession(sessionId)
    } catch (err) {
      throw mapAgentError(err)
    }
    agentService.abort(sessionId)
    // 用户点了停止:该会话挂起的确认卡一并按拒绝收尾,不留 5 分钟死等
    approvalBroker?.abortAllForSession(sessionId, '已停止,本次未执行')
  })
}

function mapAgentError(err: unknown): unknown {
  if (err instanceof AgentBusyError) {
    return ipcError('EAGENT_BUSY', err.message)
  }
  if (err instanceof ModelNotReadyError) {
    return ipcError(
      'EPROVIDER_NOT_CONFIGURED',
      '当前厂商的模型还没准备好:请在设置页填好 Key 并测试连通,或稍后再试',
    )
  }
  if (err instanceof SessionNotFoundError) {
    return ipcError('ESESSION_NOT_FOUND', '会话不存在或已被删除')
  }
  if (err instanceof SessionCreateError) {
    return ipcError('EINVALID_REQUEST', err.message)
  }
  if (err instanceof InternalSessionAccessError) {
    return ipcError('EINVALID_REQUEST', err.message)
  }
  if (err instanceof PromptComposerError) {
    // 守则异常(超长/文件损坏):消息带具体中文指引,不能落到通用"出了点问题"
    return ipcError('EINVALID_REQUEST', err.message)
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/active writer/i.test(msg)) {
    // pi writer lease 30s TTL:强杀后立即重启的旧会话打不开(专审整改:给人话而非"出了点问题")
    return ipcError('ESESSION_BUSY', '这个会话可能刚被占用,过半分钟再打开就好了(数据没有丢)')
  }
  if (/not_found|工作文件夹/.test(msg)) {
    // 挂载目录已消失:角色暂时失语,给可操作指引(remount 能力排期后续版本)
    return ipcError('EINVALID_REQUEST', '这个角色的工作文件夹不存在(可能被移动或删除),暂时发不了消息;把文件夹放回原位置,或新建一个角色')
  }
  return err
}
