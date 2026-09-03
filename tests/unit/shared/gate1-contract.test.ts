import { describe, expect, expectTypeOf, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import type {
  FileApprovalRequest,
  MemoryListPage,
  MemoryNoteSummary,
  SkillCandidateApprovalRequest,
  SkillInstallApprovalRequest,
  SkillListSnapshot,
} from '../../../src/shared/domain'
import type { IpcRequestMap } from '../../../src/shared/ipc/contracts'
import {
  FileApprovalRequestSchema,
  MemoryClearResponseSchema,
  MemoryDeleteResponseSchema,
  MemoryListPageSchema,
  SKILL_MARKET_LIMITS,
  SkillCandidateApprovalRequestSchema,
  SkillInstallApprovalRequestSchema,
  SkillListSnapshotSchema,
  SkillOpenFolderRequestSchema,
  validateApprovalResponseForRequest,
  validateRequest,
  validateResponse,
} from '../../../src/shared/ipc/schemas'
import {
  demoSkillCandidateApproval,
  demoSkillInstallApproval,
  MockBridge,
} from '../../helpers/mock-bridge'

describe('0.7.0 Gate 1 A/B/E 领域与 IPC 契约', () => {
  it('技能、分页和卸载 request/response 类型冻结', () => {
    expectTypeOf<IpcRequestMap['skill:list']['response']>().toEqualTypeOf<SkillListSnapshot>()
    expectTypeOf<IpcRequestMap['skill:uninstall']['response']>().toEqualTypeOf<SkillListSnapshot>()
    expectTypeOf<IpcRequestMap['memory:list']['response']>().toEqualTypeOf<MemoryListPage>()
    expectTypeOf<IpcRequestMap['memory:list']['response']['entries'][number]>()
      .toEqualTypeOf<MemoryNoteSummary>()
  })

  it('skill:uninstall 不接收路径，冻结 skillId 与 generation 上限', () => {
    expect(validateRequest('skill:uninstall', { skillId: 'global:demo', expectedGeneration: 0 }).ok).toBe(true)
    expect(validateRequest('skill:uninstall', { skillId: 'x'.repeat(201), expectedGeneration: 0 }).ok).toBe(false)
    expect(validateRequest('skill:uninstall', { skillId: 'global:demo', expectedGeneration: -1 }).ok).toBe(false)
    expect(validateRequest('skill:uninstall', {
      skillId: 'global:demo', expectedGeneration: 1, path: 'C:\\secret',
    } as never).ok).toBe(false)
  })

  it('memory:list 分页参数限制 limit 1..100、cursor 最长 256 且拒绝额外字段', () => {
    expect(validateRequest('memory:list', {}).ok).toBe(true)
    expect(validateRequest('memory:list', { limit: 1, cursor: 'opaque' }).ok).toBe(true)
    expect(validateRequest('memory:list', { limit: 100 }).ok).toBe(true)
    for (const payload of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'x'.repeat(257) }, { path: 'x' }]) {
      expect(validateRequest('memory:list', payload as never).ok).toBe(false)
    }
  })

  it('技能候选限定 1..8 且 opaque optionId 不接受 URL/slug 路径', () => {
    const request = demoSkillCandidateApproval()
    expect(Value.Check(SkillCandidateApprovalRequestSchema, request)).toBe(true)
    expect(Value.Check(SkillCandidateApprovalRequestSchema, { ...request, candidates: [] })).toBe(false)
    expect(Value.Check(SkillCandidateApprovalRequestSchema, {
      ...request,
      candidates: Array.from({ length: 9 }, (_, index) => ({
        ...request.candidates[0], optionId: `option_${index}`,
      })),
    })).toBe(false)
    for (const optionId of ['github.com/owner/repo', 'owner/repo', 'https://example.test/x']) {
      expect(Value.Check(SkillCandidateApprovalRequestSchema, {
        ...request,
        candidates: [{ ...request.candidates[0], optionId }],
      })).toBe(false)
    }
  })

  it('技能审批语义 fail-closed：候选批准须选当前 option，安装禁 option/session', () => {
    const candidate = demoSkillCandidateApproval()
    const install = demoSkillInstallApproval()
    expect(validateApprovalResponseForRequest(candidate, {
      approvalId: candidate.id, decision: 'approve', selectedOptionId: candidate.candidates[0]!.optionId,
    })).toBe(true)
    expect(validateApprovalResponseForRequest(candidate, {
      approvalId: candidate.id, decision: 'approve',
    })).toBe(false)
    expect(validateApprovalResponseForRequest(candidate, {
      approvalId: candidate.id, decision: 'approve', selectedOptionId: 'option_forged',
    })).toBe(false)
    expect(validateApprovalResponseForRequest(candidate, {
      approvalId: candidate.id, decision: 'approve-session',
    })).toBe(false)
    expect(validateApprovalResponseForRequest(install, {
      approvalId: install.id, decision: 'approve', selectedOptionId: candidate.candidates[0]!.optionId,
    })).toBe(false)
    expect(validateApprovalResponseForRequest(install, {
      approvalId: install.id, decision: 'approve-session',
    })).toBe(false)
  })

  it('标题/简介/owner/license/Markdown UTF-8 字节上限和 additionalProperties 全冻结', () => {
    const candidate: SkillCandidateApprovalRequest = demoSkillCandidateApproval()
    const install: SkillInstallApprovalRequest = demoSkillInstallApproval()
    expect(Value.Check(SkillCandidateApprovalRequestSchema, {
      ...candidate, title: '题'.repeat(SKILL_MARKET_LIMITS.title + 1),
    })).toBe(false)
    expect(Value.Check(SkillCandidateApprovalRequestSchema, {
      ...candidate,
      candidates: [{ ...candidate.candidates[0], summary: '简'.repeat(SKILL_MARKET_LIMITS.summary + 1) }],
    })).toBe(false)
    expect(Value.Check(SkillInstallApprovalRequestSchema, {
      ...install,
      markdownPreview: '中'.repeat(Math.floor(SKILL_MARKET_LIMITS.markdownPreviewBytes / 3) + 1),
    })).toBe(false)
    expect(Value.Check(SkillInstallApprovalRequestSchema, { ...install, rawUrl: 'https://x' })).toBe(false)
  })

  it('普通 WRITE 卡 contentPreview 有 UTF-8 上限且对象严格', () => {
    const request: FileApprovalRequest = {
      id: 'approval-write-demo', kind: 'write', title: '写技能', description: '预览技能正文',
      itemCount: 1, samplePaths: [], recoverable: false, outsideWorkspace: false,
      toolCallId: 'tool-write-demo', toolName: 'write_file', createdAt: 1,
      contentPreview: '# demo',
    }
    expect(Value.Check(FileApprovalRequestSchema, request)).toBe(true)
    expect(Value.Check(FileApprovalRequestSchema, { ...request, path: 'C:\\secret' })).toBe(false)
    expect(Value.Check(FileApprovalRequestSchema, {
      ...request,
      contentPreview: '中'.repeat(Math.floor(SKILL_MARKET_LIMITS.contentPreviewBytes / 3) + 1),
    })).toBe(false)
  })

  it('response schema 在 renderer 前拒绝额外字段和旧记忆快照', () => {
    const skills = { generation: 1, skills: [], diagnostics: [], effectiveFrom: 'new-session' }
    const memories = { revision: 1, mergeState: 'clean', entries: [], total: 0, reset: false }
    expect(Value.Check(SkillListSnapshotSchema, skills)).toBe(true)
    expect(Value.Check(SkillListSnapshotSchema, { ...skills, content: '正文' })).toBe(false)
    expect(validateResponse('skill:list', {
      ...skills,
      skills: [{
        id: 'global:manual', name: 'manual', description: '', source: { kind: 'global' },
        builtIn: false, logicalLocation: 'daweige-skill://global/manual/SKILL.md',
        provenance: { kind: 'manual' }, canUninstall: true,
      }],
    }).ok).toBe(false)
    expect(Value.Check(MemoryListPageSchema, memories)).toBe(true)
    expect(Value.Check(MemoryListPageSchema, { revision: 1, mergeState: 'clean', entries: [] })).toBe(false)
    expect(validateResponse('memory:list', { ...memories, path: 'x' }).ok).toBe(false)
    expect(Value.Check(MemoryDeleteResponseSchema, { deleted: true, revision: 2, mergeState: 'pending' })).toBe(true)
    expect(Value.Check(MemoryClearResponseSchema, { deletedCount: 3, revision: 4, mergeState: 'pending' })).toBe(true)
    expect(Value.Check(SkillOpenFolderRequestSchema, { scope: 'global', roleId: 'x' })).toBe(false)
  })

  it('MockBridge 提供分页/provenance/技能审批/卸载 fixtures', async () => {
    const bridge = new MockBridge().seedDemoState()
    const skills = await bridge.invoke('skill:list', undefined)
    expect(skills.skills[0]?.provenance.kind).toBe('market')
    const page = await bridge.invoke('memory:list', { limit: 1 })
    expect(page).toMatchObject({ total: 1, reset: false })
    const uninstalled = await bridge.invoke('skill:uninstall', {
      skillId: skills.skills[0]!.id,
      expectedGeneration: skills.generation,
    })
    expect(uninstalled.skills).toHaveLength(0)
    expect(demoSkillCandidateApproval().kind).toBe('skill-candidate')
    expect(demoSkillInstallApproval().kind).toBe('skill-install')
    const deleted = await bridge.invoke('memory:delete', { memoryId: page.entries[0]!.id })
    expect(deleted.mergeState).toBe('pending')
  })
})
