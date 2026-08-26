/**
 * IPC 通道清单——M1-03 冻结。
 * 通道名一经冻结不可改名;新增通道需走契约变更评审并同步 main/renderer/mock 三方。
 */

/** 渲染进程 → 主进程 的请求/响应(invoke)通道。 */
export const INVOKE_CHANNELS = [
  'app:getBootstrapState',
  'workspace:choose',
  'role:listTemplates',
  'role:list',
  'role:get',
  'role:create',
  'role:update',
  'role:updateGuardrails',
  'role:archive',
  'role:restore',
  'role:getDeleteImpact',
  'role:delete',
  'session:list',
  'session:create',
  'session:open',
  'session:rename',
  'session:delete',
  'session:archive',
  'session:restore',
  'agentRun:list',
  'agentRun:getDetail',
  'message:send',
  'message:abort',
  'approval:respond',
  'settings:get',
  'settings:update',
  'credential:status',
  'credential:save',
  'credential:delete',
  'credential:test',
  'credential:listModels',
  'reminder:listUpcoming',
  'memory:list',
  'memory:delete',
  'usage:getDashboard',
  'workspace:importFiles',
  'app:checkUpdate',
  'update:download',
  'update:install',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/** 主进程 → 渲染进程 的推送通道。 */
export const PUSH_CHANNELS = ['agent:event'] as const

export type PushChannel = (typeof PUSH_CHANNELS)[number]

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return (
    typeof value === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(value)
  )
}
