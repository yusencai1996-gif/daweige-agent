import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { createEditRoleGuardrailsTool } from '../../../src/main/agent/tools/edit-role-guardrails'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { createRoleFixture, type RoleFixture } from '../../integration/helpers/role-fixture'

/**
 * edit_role_guardrails 工具(PLAN §10.1 安全组):
 * 无 path 参数(schema)、只改当前会话角色、唯一匹配替换、
 * 不匹配/多处匹配/超长/版本冲突一律不落盘、成功后版本递增。
 * 审批卡与授权排除在 approval-gate/broker 测试覆盖。
 */

const GUARDRAILS = '# 角色守则\n\n## 身份\n你是小编。\n\n## 不要做\n- 不写空话\n'

let dir: string
let roleFx: RoleFixture
let sessionRepo: SessionRepository
let sessionService: SessionService
let sessionId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rules-tool-'))
  roleFx = await createRoleFixture('小编')
  await roleFx.roleService.updateGuardrails(roleFx.roleId, GUARDRAILS, 1)
  sessionRepo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await sessionRepo.init()
  sessionService = new SessionService(sessionRepo, roleFx.roleRepository, roleFx.roleService)
  const detail = await sessionService.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
  sessionId = detail.summary.id
})

afterEach(async () => {
  await sessionRepo.close().catch(() => {})
  roleFx.close()
  await Promise.all([
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    rm(roleFx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
  ])
}, 20_000)

function makeTool(session = sessionId) {
  return createEditRoleGuardrailsTool({
    sessionId: session,
    roleRepository: roleFx.roleRepository,
    roleService: roleFx.roleService,
  })
}

function homeGuardrails(): string {
  const summary = roleFx.roleService.getSummary(roleFx.roleId)
  void summary
  const home = join(roleFx.userDataDir, 'daweige', 'agents', roleFx.roleId, 'guardrails.md')
  return readFileSync(home, 'utf8')
}

describe('edit_role_guardrails:参数与目标', () => {
  it('工具 schema 不含 path/roleId 参数(安全设计)', () => {
    const tool = makeTool()
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['new_string', 'old_string'])
  })

  it('无绑定会话拒绝执行', async () => {
    const tool = makeTool('not-a-bound-session')
    await expect(
      tool.execute('call-1', { old_string: '你是小编。', new_string: '你是大编。' }),
    ).rejects.toThrow('没有挂在角色下')
  })
})

describe('edit_role_guardrails:替换语义', () => {
  it('唯一匹配替换成功,守则文件与版本更新', async () => {
    const tool = makeTool()
    const result = await tool.execute('call-1', { old_string: '你是小编。', new_string: '你是资深小编。' })
    expect((result.content[0] as { text: string }).text).toContain('已更新')
    expect(homeGuardrails()).toContain('你是资深小编。')
    const detail = await roleFx.roleService.getDetail(roleFx.roleId)
    expect(detail.guardrailsVersion).toBe(3) // fixture 创建=1,测试 setUp 改=2,本次=3
  })

  it('new_string 为空 = 删除该片段', async () => {
    const tool = makeTool()
    await tool.execute('call-1', { old_string: '- 不写空话\n', new_string: '' })
    expect(homeGuardrails()).not.toContain('不写空话')
  })

  it('old_string 不存在 → 不落盘,提示引用原文', async () => {
    const tool = makeTool()
    await expect(tool.execute('call-1', { old_string: '根本不存在的句子', new_string: 'x' })).rejects.toThrow(
      '找不到要替换的原句',
    )
    expect(homeGuardrails()).toBe(GUARDRAILS)
  })

  it('old_string 多处匹配 → 不落盘,要求更多上下文', async () => {
    const tool = makeTool()
    // GUARDRAILS 里 "\n\n" 出现多次;用带双空行的片段构造真实重复
    await expect(tool.execute('call-1', { old_string: '\n\n', new_string: 'x' })).rejects.toThrow('不止一次')
    expect(homeGuardrails()).toBe(GUARDRAILS)
  })

  it('替换后超 6000 字 → 不落盘', async () => {
    const tool = makeTool()
    await expect(
      tool.execute('call-1', { old_string: '你是小编。', new_string: '长'.repeat(6_001) }),
    ).rejects.toThrow('超长')
    expect(homeGuardrails()).toBe(GUARDRAILS)
  })

  it('落盘时版本冲突(确认期间被改) → 不落盘,提示重读', async () => {
    const tool = makeTool()
    // 直接让底层 updateGuardrails 抛冲突(乐观并发在 service 层已有专项测试)
    ;(roleFx.roleService as unknown as { updateGuardrails: () => Promise<never> }).updateGuardrails =
      async () => {
        const err = new Error('conflict') as Error & { code?: string }
        err.code = 'GUARDRAILS_VERSION_CONFLICT'
        throw err
      }
    await expect(tool.execute('call-1', { old_string: '你是小编。', new_string: '你是大编。' })).rejects.toThrow(
      '没有执行',
    )
    expect(homeGuardrails()).toBe(GUARDRAILS)
  })
})
