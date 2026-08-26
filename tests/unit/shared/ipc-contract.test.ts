import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  INVOKE_CHANNELS,
  isInvokeChannel,
  type InvokeChannel,
} from '../../../src/shared/ipc/channels'
import type { IpcRequestMap, ContractChannel } from '../../../src/shared/ipc/contracts'
import { REQUEST_SCHEMAS, validateRequest } from '../../../src/shared/ipc/schemas'
import { MockBridge } from '../../helpers/mock-bridge'

// ---------- apiKey 红线(类型级)----------

type Primitive = string | number | bigint | boolean | null | undefined | void
/** 深度检索类型中是否出现名为 apiKey 的属性键。 */
type HasApiKey<T> = T extends Primitive
  ? false
  : T extends readonly unknown[]
    ? HasApiKey<T[number]>
    : 'apiKey' extends keyof T
      ? true
      : true extends { [K in keyof T]-?: HasApiKey<T[K]> }[keyof T]
        ? true
        : false

describe('IPC 契约:通道冻结', () => {
  it('契约键与冻结清单双向一致(类型级)', () => {
    expectTypeOf<keyof IpcRequestMap>().toEqualTypeOf<ContractChannel>()
    expectTypeOf<ContractChannel>().toEqualTypeOf<InvokeChannel>()
  })

  it('INVOKE_CHANNELS 运行时清单与类型一致', () => {
    for (const ch of INVOKE_CHANNELS) {
      expect(isInvokeChannel(ch), `通道 ${ch} 不在清单中`).toBe(true)
    }
    expect(INVOKE_CHANNELS).toHaveLength(42)
    expect(new Set(INVOKE_CHANNELS).size).toBe(42)
  })

  it('request 非 void 的通道必须注册运行时 schema(0.2.1 热修教训:漏注册→"不接受任何参数")', () => {
    // 契约中 request 为 void 的通道(增删通道时同步维护;长度断言防清单过时)
    const voidChannels = new Set([
      'app:getBootstrapState',
      'workspace:choose',
      'role:listTemplates',
      'role:list',
      'session:list',
      'reminder:listUpcoming',
      'memory:list',
      'usage:getDashboard',
      'app:checkUpdate',
      'update:download',
      'update:install',
      'window:minimize',
      'window:toggleMaximize',
      'window:close',
      'settings:get',
      'credential:status',
    ])
    expect(INVOKE_CHANNELS).toHaveLength(voidChannels.size + Object.keys(REQUEST_SCHEMAS).length)
    for (const ch of INVOKE_CHANNELS) {
      if (voidChannels.has(ch)) continue
      expect(REQUEST_SCHEMAS[ch as ContractChannel], `通道 ${ch} 缺运行时 schema`).toBeDefined()
    }
    for (const ch of Object.keys(REQUEST_SCHEMAS)) {
      expect(voidChannels.has(ch), `通道 ${ch} 注册了 schema 但契约 request 是 void`).toBe(false)
    }
  })
})

describe('IPC 契约:入参运行时校验', () => {
  it('合法的 session:create(roleId 形态)通过', () => {
    const r = validateRequest('session:create', {
      roleId: 'agent-a1b2c3d4e5f6',
      providerId: 'kimi-coding',
      modelId: 'kimi-for-coding',
    })
    expect(r.ok).toBe(true)
  })

  it('session:create 接受内置总管字面量,拒绝其他 sys-*(0.3.0)', () => {
    expect(
      validateRequest('session:create', {
        roleId: 'sys-xiaozhen',
        providerId: 'kimi-coding',
        modelId: 'kimi-for-coding',
      }).ok,
    ).toBe(true)
    for (const roleId of ['sys-evil', 'sys-xiaozhen-fake', 'SYS-XIAOZHEN']) {
      const r = validateRequest('session:create', {
        roleId,
        providerId: 'kimi-coding',
        modelId: 'kimi-for-coding',
      })
      expect(r.ok, `roleId ${roleId} 应被拒绝`).toBe(false)
    }
  })

  it('agentRun 通道:合法 runId/managerSessionId 通过,伪造形态被拒(0.3.0)', () => {
    expect(
      validateRequest('agentRun:list', { managerSessionId: 'demo-session-manager' }).ok,
    ).toBe(true)
    expect(
      validateRequest('agentRun:getDetail', { runId: 'run-a1b2c3d4e5f60718' }).ok,
    ).toBe(true)
    for (const runId of ['run-ABC', 'run-a1b2c3d4e5f6071', 'run-a1b2c3d4e5f607188', 'agent-a1b2c3d4e5f6', '']) {
      const r = validateRequest('agentRun:getDetail', { runId })
      expect(r.ok, `runId ${runId} 应被拒绝`).toBe(false)
    }
    expect(validateRequest('agentRun:list', {}).ok).toBe(false)
  })

  it('相对路径 workspacePath 被拒(role:create)', () => {
    const r = validateRequest('role:create', {
      displayName: '小编',
      workspacePaths: ['relative/path'],
      primaryWorkspacePath: 'relative/path',
      templateId: 'writer',
      guardrails: '',
    })
    expect(r.ok).toBe(false)
  })

  it('含 .. 逃逸段的路径被拒', () => {
    for (const p of [
      'C:\\Users\\demo\\..\\..\\Windows',
      'C:/Users/demo/../secret',
      'C:\\..\\evil',
    ]) {
      const r = validateRequest('session:create', {
        workspacePath: p,
        providerId: 'kimi-coding',
        modelId: 'kimi-for-coding',
      })
      expect(r.ok, `路径 ${p} 应被拒绝`).toBe(false)
    }
  })

  it('未知 providerId 被拒', () => {
    const r = validateRequest('credential:save', {
      providerId: 'openai',
      apiKey: 'sk-12345678',
    })
    expect(r.ok).toBe(false)
  })

  it('伪造确认 ID(空/过短)被拒', () => {
    expect(validateRequest('approval:respond', { approvalId: '', decision: 'approve' }).ok).toBe(false)
    expect(
      validateRequest('approval:respond', { approvalId: 'short', decision: 'approve' }).ok,
    ).toBe(false)
  })

  it('未知 decision 值被拒', () => {
    const r = validateRequest('approval:respond', {
      approvalId: 'abcd1234abcd',
      decision: 'yes',
    })
    expect(r.ok).toBe(false)
  })

  it('超长会话标题(>60 字)被拒', () => {
    const r = validateRequest('session:rename', {
      sessionId: 'sess-1',
      title: '超'.repeat(61),
    })
    expect(r.ok).toBe(false)
  })

  it('额外字段被拒(渲染进程不可信,不接受未知属性)', () => {
    const r = validateRequest('session:open', {
      sessionId: 'sess-1',
      extra: 'injected',
    })
    expect(r.ok).toBe(false)
  })

  it('错误类型被拒(sessionId 传数字)', () => {
    const r = validateRequest('session:open', { sessionId: 12345 })
    expect(r.ok).toBe(false)
  })

  it('合法的 approval:respond(带拒绝附言)通过', () => {
    const r = validateRequest('approval:respond', {
      approvalId: 'approval-abc12345',
      decision: 'reject',
      note: '二月的先别动',
    })
    expect(r.ok).toBe(true)
  })

  it('request 为 void 的通道:不接受多余 payload', () => {
    expect(validateRequest('session:list', undefined).ok).toBe(true)
    expect(validateRequest('session:list', null).ok).toBe(true)
    const bad = validateRequest('session:list', { hack: true } as never)
    expect(bad.ok).toBe(false)
  })

  it('message:send 的 text 上限 100000 字', () => {
    const ok = validateRequest('message:send', {
      sessionId: 'sess-1',
      text: '好'.repeat(100_000),
    })
    expect(ok.ok).toBe(true)
    const tooLong = validateRequest('message:send', {
      sessionId: 'sess-1',
      text: '好'.repeat(100_001),
    })
    expect(tooLong.ok).toBe(false)
  })
})

describe('IPC 契约:角色通道(0.2.0)', () => {
  const validCreate = {
    displayName: '小编',
    workspacePaths: ['C:\\Users\\demo\\Documents\\稿件'],
    primaryWorkspacePath: 'C:\\Users\\demo\\Documents\\稿件',
    templateId: 'writer',
    guardrails: '# 角色守则\n\n## 身份\n你是小编。',
  }

  it('合法的 role:create 通过', () => {
    expect(validateRequest('role:create', validCreate).ok).toBe(true)
  })

  it(' roleId 拒绝非 agent- 前缀/大写/错误长度(sys- 总管预留被拒)', () => {
    for (const roleId of [
      'sys-xiaozhen',
      'agent-ABCDEF123456',
      'agent-a1b2c3',
      'agent-a1b2c3d4e5f66',
      '../evil',
      '',
    ]) {
      const r = validateRequest('role:get', { roleId })
      expect(r.ok, `roleId ${roleId} 应被拒绝`).toBe(false)
    }
    expect(validateRequest('role:get', { roleId: 'agent-a1b2c3d4e5f6' }).ok).toBe(true)
  })

  it('role:create 显示名:首尾空白/超 24 字被拒', () => {
    for (const displayName of [' 小编', '小编 ', '', '太'.repeat(25)]) {
      const r = validateRequest('role:create', { ...validCreate, displayName })
      expect(r.ok, `显示名 "${displayName}" 应被拒绝`).toBe(false)
    }
  })

  it('role:create 守则超 6000 字被拒;legacy-empty 模板被拒', () => {
    const tooLong = validateRequest('role:create', {
      ...validCreate,
      guardrails: '守'.repeat(6_001),
    })
    expect(tooLong.ok).toBe(false)
    const legacy = validateRequest('role:create', { ...validCreate, templateId: 'legacy-empty' })
    expect(legacy.ok).toBe(false)
  })

  it('role:create workspacePaths 空数组/重复路径/相对路径被拒', () => {
    expect(validateRequest('role:create', { ...validCreate, workspacePaths: [] }).ok).toBe(false)
    const dup = validateRequest('role:create', {
      ...validCreate,
      workspacePaths: ['C:\\a', 'C:\\a'],
      primaryWorkspacePath: 'C:\\a',
    })
    expect(dup.ok).toBe(false)
    expect(
      validateRequest('role:create', {
        ...validCreate,
        workspacePaths: ['relative/path'],
        primaryWorkspacePath: 'relative/path',
      }).ok,
    ).toBe(false)
  })

  it('session:create 只接受 roleId,不再接受 workspacePath', () => {
    expect(
      validateRequest('session:create', {
        roleId: 'agent-a1b2c3d4e5f6',
        providerId: 'kimi-coding',
        modelId: 'kimi-for-coding',
      }).ok,
    ).toBe(true)
    expect(
      validateRequest('session:create', {
        workspacePath: 'C:\\demo',
        providerId: 'kimi-coding',
        modelId: 'kimi-for-coding',
      } as never).ok,
    ).toBe(false)
  })

  it('role:delete 只接受 deleteSessions: true', () => {
    const base = {
      roleId: 'agent-a1b2c3d4e5f6',
      confirmDisplayName: '小编',
      impactVersion: 'v12345678',
    }
    expect(validateRequest('role:delete', { ...base, deleteSessions: true }).ok).toBe(true)
    expect(validateRequest('role:delete', { ...base, deleteSessions: false } as never).ok).toBe(
      false,
    )
  })

  it('role:updateGuardrails 拒绝 expectedVersion 为 0/非整数', () => {
    const base = { roleId: 'agent-a1b2c3d4e5f6', guardrails: '' }
    expect(validateRequest('role:updateGuardrails', { ...base, expectedVersion: 1 }).ok).toBe(true)
    expect(validateRequest('role:updateGuardrails', { ...base, expectedVersion: 0 }).ok).toBe(false)
    expect(
      validateRequest('role:updateGuardrails', { ...base, expectedVersion: 1.5 } as never).ok,
    ).toBe(false)
  })

  it('session:archive/session:restore 拒绝空 sessionId', () => {
    expect(validateRequest('session:archive', { sessionId: '' }).ok).toBe(false)
    expect(validateRequest('session:restore', { sessionId: 'sess-1' }).ok).toBe(true)
  })
})

describe('IPC 契约:apiKey 红线', () => {
  it('所有 response 类型(递归)不含 apiKey 字段——类型级断言', () => {
    expectTypeOf<
      HasApiKey<IpcRequestMap[ContractChannel]['response']>
    >().toEqualTypeOf<false>()
    // 重点类型逐个复核
    expectTypeOf<HasApiKey<IpcRequestMap['app:getBootstrapState']['response']>>().toEqualTypeOf<false>()
    expectTypeOf<HasApiKey<IpcRequestMap['session:open']['response']>>().toEqualTypeOf<false>()
    expectTypeOf<HasApiKey<IpcRequestMap['credential:save']['response']>>().toEqualTypeOf<false>()
    expectTypeOf<HasApiKey<IpcRequestMap['credential:test']['response']>>().toEqualTypeOf<false>()
  })

  it('运行时:REQUEST_SCHEMAS 中只有 credential:save 含 apiKey 属性', () => {
    const channelsWithApiKey: string[] = []
    for (const [channel, schema] of Object.entries(REQUEST_SCHEMAS)) {
      if (schema && 'apiKey' in schema.properties) {
        channelsWithApiKey.push(channel)
      }
    }
    expect(channelsWithApiKey).toEqual(['credential:save'])
  })
})

describe('MockBridge', () => {
  it('记录调用并返回注册的行为', async () => {
    const bridge = new MockBridge()
    const detail = {
      summary: {
        id: 's1',
        title: '测试会话',
        workspacePath: 'C:\\demo',
        roleId: 'agent-a1b2c3d4e5f6',
        archivedAt: null,
        providerId: 'kimi-coding' as const,
        modelId: 'kimi-for-coding',
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
      },
      messages: [],
    }
    bridge.handle('session:open', () => Promise.resolve(detail))
    await bridge.invoke('session:open', { sessionId: 's1' })
    expect(bridge.calls).toEqual([{ channel: 'session:open', payload: { sessionId: 's1' } }])
  })

  it('未注册通道 invoke 拒绝并给出可读提示', async () => {
    const bridge = new MockBridge()
    await expect(bridge.invoke('session:list', undefined)).rejects.toThrow(/未注册行为/)
  })

  it('seedDemoState 覆盖常用通道;凭据只含掩码', async () => {
    const bridge = new MockBridge().seedDemoState()
    const bootstrap = await bridge.invoke('app:getBootstrapState', undefined)
    expect(bootstrap.providers).toHaveLength(4)
    expect(bootstrap.sessions.length).toBeGreaterThan(0)
    expect(JSON.stringify(bootstrap.credentialStatuses)).toContain('maskedKey')
    expect(JSON.stringify(bootstrap)).not.toMatch(/"apiKey"\s*:/)
  })

  it('onAgentEvent 可订阅/取消;emitAgentEvent 送达订阅者', () => {
    const bridge = new MockBridge()
    const received: string[] = []
    const off = bridge.onAgentEvent((e) => received.push(e.type))
    bridge.emitAgentEvent({ type: 'agent_end', sessionId: 's1' })
    off()
    bridge.emitAgentEvent({ type: 'agent_end', sessionId: 's1' })
    expect(received).toEqual(['agent_end'])
  })
})
