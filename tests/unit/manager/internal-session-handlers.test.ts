import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InternalSessionAccessError } from '../../../src/main/storage/session-service'

const handlers = new Map<string, (payload: never) => Promise<unknown>>()

vi.mock('../../../src/main/ipc/handler', () => ({
  registerHandler: (channel: string, handler: (payload: never) => Promise<unknown>) => {
    handlers.set(channel, handler)
  },
  ipcError: (code: string, message: string) => Object.assign(new Error(message), { code }),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: { showOpenDialog: vi.fn() },
}))

import { registerSessionHandlers } from '../../../src/main/ipc/session-handlers'
import { registerMessageHandlers } from '../../../src/main/ipc/message-handlers'
import { registerWorkspaceHandlers } from '../../../src/main/ipc/workspace-handlers'
import { registerAgentRunHandlers } from '../../../src/main/ipc/agent-run-handlers'

function internalRejectingService() {
  return {
    assertUserVisibleSession: vi.fn(async () => {
      throw new InternalSessionAccessError()
    }),
    assertSessionNotArchived: vi.fn(),
    openDetail: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    setArchived: vi.fn(),
    listSummaries: vi.fn(),
    create: vi.fn(),
  }
}

beforeEach(() => {
  handlers.clear()
})

describe('internal 会话的用户 IPC 防线', () => {
  it('session:create 只按主进程角色设置选模型', async () => {
    const service = internalRejectingService()
    service.create.mockResolvedValue({ summary: { id: 'session-1' }, messages: [] })
    const settingsStore = {
      load: vi.fn(async () => ({
        providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
        enabledModels: [
          { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
          { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        ],
        roleModelDefaults: {
          'agent-a1b2c3d4e5f6': { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        },
      })),
    }
    registerSessionHandlers(service as never, undefined, undefined, undefined, settingsStore as never)
    await handlers.get('session:create')!({ roleId: 'agent-a1b2c3d4e5f6' } as never)
    expect(service.create).toHaveBeenCalledWith({
      roleId: 'agent-a1b2c3d4e5f6',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
    })
  })

  it('message:send 允许池内选择并拒绝池外选择', async () => {
    const service = {
      assertUserVisibleSession: vi.fn(),
      assertSessionNotArchived: vi.fn(),
    }
    const agentService = { send: vi.fn(async () => ({ kind: 'chat', role: 'user' })), abort: vi.fn() }
    const settingsStore = { load: vi.fn(async () => ({
      providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
      enabledModels: [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash' }],
    })) }
    registerMessageHandlers(agentService as never, settingsStore as never, undefined, undefined, service as never)

    const allowed = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    await handlers.get('message:send')!({ sessionId: 'user-1', text: '你好', selection: allowed } as never)
    expect(agentService.send).toHaveBeenCalledWith('user-1', '你好', allowed)

    await expect(handlers.get('message:send')!({
      sessionId: 'user-1',
      text: '伪造',
      selection: { providerId: 'kimi-coding', modelId: 'pool-outside' },
    } as never)).rejects.toThrow('所选模型不在已启用模型池中')
    expect(agentService.send).toHaveBeenCalledTimes(1)
  })

  it('批 1 的 agentRun 两通道已注册:list 为空,getDetail 明确不存在', async () => {
    registerAgentRunHandlers()
    await expect(
      handlers.get('agentRun:list')!({ managerSessionId: 'manager-1' } as never),
    ).resolves.toEqual([])
    await expect(
      handlers.get('agentRun:getDetail')!({ runId: 'run-0000000000000001' } as never),
    ).rejects.toThrow('派活记录不存在')
  })

  it('session:open/rename/delete/archive/restore 均先拒绝,不触碰底层动作', async () => {
    const service = internalRejectingService()
    const agentService = {
      restoreChatMessages: vi.fn(),
      disposeAgent: vi.fn(),
      isSessionStreaming: vi.fn(() => false),
    }
    registerSessionHandlers(service as never, agentService as never)

    for (const [channel, payload] of [
      ['session:open', { sessionId: 'internal-1' }],
      ['session:rename', { sessionId: 'internal-1', title: '不能改' }],
      ['session:delete', { sessionId: 'internal-1' }],
      ['session:archive', { sessionId: 'internal-1' }],
      ['session:restore', { sessionId: 'internal-1' }],
    ] as const) {
      await expect(handlers.get(channel)!(payload as never)).rejects.toThrow(
        '内部任务会话不能通过普通会话入口操作',
      )
    }
    expect(service.openDetail).not.toHaveBeenCalled()
    expect(service.rename).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
    expect(service.setArchived).not.toHaveBeenCalled()
    expect(agentService.disposeAgent).not.toHaveBeenCalled()
  })

  it('message:send/abort 均先拒绝,不启动或中断 agent', async () => {
    const service = internalRejectingService()
    const agentService = { send: vi.fn(), abort: vi.fn() }
    const settingsStore = { load: vi.fn() }
    registerMessageHandlers(agentService as never, settingsStore as never, undefined, undefined, service as never)

    await expect(
      handlers.get('message:send')!({ sessionId: 'internal-1', text: '越权' } as never),
    ).rejects.toThrow('内部任务会话不能通过普通会话入口操作')
    await expect(
      handlers.get('message:abort')!({ sessionId: 'internal-1' } as never),
    ).rejects.toThrow('内部任务会话不能通过普通会话入口操作')
    expect(agentService.send).not.toHaveBeenCalled()
    expect(agentService.abort).not.toHaveBeenCalled()
    expect(settingsStore.load).not.toHaveBeenCalled()
  })

  it('workspace:importFiles 先拒绝,不读取用户会话列表或弹文件框', async () => {
    const service = internalRejectingService()
    registerWorkspaceHandlers({} as never, service as never)
    await expect(
      handlers.get('workspace:importFiles')!({ sessionId: 'internal-1' } as never),
    ).rejects.toThrow('内部任务会话不能通过普通会话入口操作')
    expect(service.listSummaries).not.toHaveBeenCalled()
  })
})
