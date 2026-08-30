import { describe, expect, it } from 'vitest'
import type {
  ApprovalRequest,
  ApprovalResponse,
  ChatMessage,
  CredentialStatus,
  MemoryEntry,
  RoleDetail,
  SessionSummary,
} from '../../../src/shared/domain'

/** 判别联合的 JSON round-trip 助手:序列化→反序列化→深相等。 */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('领域模型:序列化/反序列化', () => {
  it('SessionSummary round-trip 保持字段(含 roleId/archivedAt)', () => {
    const s: SessionSummary = {
      id: 'sess-1',
      title: '整理下载文件夹',
      workspacePath: 'C:\\Users\\demo\\Downloads',
      roleId: 'agent-a1b2c3d4e5f6',
      archivedAt: null,
      providerId: 'kimi-coding',
      modelId: 'kimi-for-coding',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 6,
    }
    expect(roundTrip(s)).toEqual(s)
  })

  it('RoleDetail round-trip 保持字段', () => {
    const d: RoleDetail = {
      summary: {
        id: 'agent-a1b2c3d4e5f6',
        kind: 'worker',
        displayName: '小编',
        templateId: 'writer',
        mounts: [
          {
            workspacePath: 'C:\\Users\\demo\\文档',
            primary: true,
            availability: 'available',
          },
        ],
        archivedAt: null,
        lifecycle: 'ready' as const,
        createdAt: 1,
        updatedAt: 2,
        sessionCount: 3,
        activeSessionCount: 2,
      },
      profile: {
        schemaVersion: 1,
        roleId: 'agent-a1b2c3d4e5f6',
        templateId: 'writer',
        personaSummary: '写稿助手',
        capabilityTags: ['写作', '改稿'],
      },
      guardrails: '# 角色守则',
      guardrailsVersion: 2,
    }
    expect(roundTrip(d)).toEqual(d)
  })

  it('ChatMessage 三种形态 round-trip 保持判别字段', () => {
    const user: ChatMessage = {
      kind: 'chat',
      id: 'm1',
      role: 'user',
      text: '把图片按月份归档',
      createdAt: 1,
    }
    const assistant: ChatMessage = {
      kind: 'chat',
      id: 'm2',
      role: 'assistant',
      text: '好的,我来处理',
      createdAt: 2,
      toolExecutions: [
        {
          toolCallId: 'tc1',
          toolName: 'move_files',
          displayName: '移动文件',
          status: 'pending',
          summary: '移动 38 张图片到按月份建的文件夹',
        },
      ],
    }
    const error: ChatMessage = {
      kind: 'error',
      id: 'm3',
      role: 'error',
      text: '网络中断,请重试',
      createdAt: 3,
      retryable: true,
    }
    for (const m of [user, assistant, error]) {
      expect(roundTrip(m)).toEqual(m)
    }
  })

  it('MemoryEntry(含两种日期形态)round-trip', () => {
    const recurring: MemoryEntry = {
      id: 'mem-1',
      text: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
      createdAt: 1,
    }
    const fixed: MemoryEntry = {
      id: 'mem-2',
      text: '2027-05-01 要交稿',
      title: '交稿日',
      category: '纪念日',
      date: { kind: 'fixed', iso: '2027-05-01' },
      createdAt: 2,
    }
    const noDate: MemoryEntry = {
      id: 'mem-3',
      text: '用户喜欢喝绿茶',
      title: '饮茶偏好',
      category: '偏好',
      createdAt: 3,
    }
    for (const m of [recurring, fixed, noDate]) {
      expect(roundTrip(m)).toEqual(m)
    }
  })

  it('ApprovalRequest/Response round-trip', () => {
    const req: ApprovalRequest = {
      id: 'approval-abc123',
      kind: 'move',
      title: '我要移动 38 个文件',
      description: '把这 38 张图片移到按月份建好的文件夹里',
      itemCount: 38,
      samplePaths: ['C:\\Downloads\\img-001.jpg'],
      recoverable: true,
      outsideWorkspace: false,
      toolCallId: 'tc1',
      createdAt: 1,
    }
    const approve: ApprovalResponse = { approvalId: req.id, decision: 'approve' }
    const reject: ApprovalResponse = {
      approvalId: req.id,
      decision: 'reject',
      note: '二月的先别动',
    }
    expect(roundTrip(req)).toEqual(req)
    expect(roundTrip(approve)).toEqual(approve)
    expect(roundTrip(reject)).toEqual(reject)
  })

  it('CredentialStatus 两种形态 round-trip,且只含掩码不含完整 key', () => {
    const off: CredentialStatus = { providerId: 'zai', configured: false }
    const on: CredentialStatus = {
      providerId: 'kimi-coding',
      configured: true,
      maskedKey: 'sk-****abcd',
    }
    expect(roundTrip(off)).toEqual(off)
    expect(roundTrip(on)).toEqual(on)
    expect(JSON.stringify(on)).not.toContain('sk-real-secret-value')
  })
})

describe('领域模型:判别联合穷尽性', () => {
  it('ChatMessage 的 kind+role 联合覆盖全部已知形态', () => {
    const kinds: ChatMessage['kind'][] = ['chat', 'error', 'compaction']
    const roles: Extract<ChatMessage, { kind: 'chat' }>['role'][] = ['user', 'assistant']
    expect(kinds).toHaveLength(3)
    expect(roles).toHaveLength(2)
  })

  it('对 role 做穷尽 switch 后 default 分支收窄为 never(编译即验证)', () => {
    const describe_ = (m: ChatMessage): string => {
      switch (m.role) {
        case 'user':
          return '我'
        case 'assistant':
          return 'AI'
        case 'error':
          return '出错了'
        case 'system':
          return '上下文摘要'
        default: {
          // 若 ChatMessage 新增 role 而这里没处理,m.role 不再是 never,编译报错
          const exhaustive: never = m
          return exhaustive
        }
      }
    }
    expect(
      describe_({ kind: 'chat', id: 'x', role: 'user', text: '', createdAt: 0 }),
    ).toBe('我')
  })
})
