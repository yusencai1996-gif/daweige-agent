import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, type Context } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'
import { AgentService } from '../../../src/main/agent/agent-service'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { createRoleFixture, type RoleFixture } from '../helpers/role-fixture'

/**
 * A4 每回合刷新(PLAN §3.2):守则修改后从下一条用户消息生效;
 * 同角色多会话共享最新守则;会话无绑定时只有全局底子。
 */

let dir: string
let roleFx: RoleFixture
let repo: SessionRepository
let events: AgentPushEvent[]
let capturedPrompts: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prompt-refresh-'))
  roleFx = await createRoleFixture('小编')
  repo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await repo.init()
  events = []
  capturedPrompts = []
})

afterEach(async () => {
  await repo.close().catch(() => {})
  roleFx.close()
  await Promise.all([
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
    rm(roleFx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}),
  ])
}, 20_000)

function makeService(guardrailsGetter: () => string, useRoleBinding: boolean) {
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  faux.setResponses([fauxAssistantMessage('收到')])
  const models = createModels()
  models.setProvider(faux.provider)
  const fauxModel = faux.getModel()

  const sessionService = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
  return new AgentService({
    models: {
      getModel: () => fauxModel,
      streamSimple: (m, context: Context, options) => {
        capturedPrompts.push(String((context as { systemPrompt?: unknown }).systemPrompt ?? ''))
        return models.streamSimple(m, context, options)
      },
      completeSimple: (m, context, options) => models.completeSimple(m, context, options),
    },
    sessionService,
    emitEvent: (e) => events.push(e),
    rolePrompt: useRoleBinding
      ? async () => ({
          roleId: roleFx.roleId,
          displayName: '小编',
          templateId: 'writer' as const,
          guardrails: guardrailsGetter(),
        })
      : undefined,
  })
}

async function waitAgentEnd(): Promise<void> {
  const start = Date.now()
  while (!events.some((e) => e.type === 'agent_end')) {
    if (Date.now() - start > 8000) throw new Error('等待 agent_end 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('守则每回合刷新', () => {
  it('改守则后,下一条消息携带新守则(旧消息不重写)', async () => {
    let guardrails = '# 角色守则 v1'
    const service = makeService(() => guardrails, true)
    const sessionService = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
    const a = await sessionService.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'faux' })
    const selection = { providerId: 'kimi-coding' as const, modelId: 'faux' }

    await service.send(a.summary.id, '第一条', selection)
    await waitAgentEnd()
    events.length = 0

    guardrails = '# 角色守则 v2\n\n## 特别规矩\n- 每句话都以"好嘞"开头'
    await service.send(a.summary.id, '第二条', selection)
    await waitAgentEnd()

    expect(capturedPrompts.length).toBeGreaterThanOrEqual(2)
    expect(capturedPrompts[0]).toContain('# 角色守则 v1')
    expect(capturedPrompts[1]).toContain('# 角色守则 v2')
    expect(capturedPrompts[1]).not.toContain('# 角色守则 v1\n')
  })

  it('同角色两会话:守则共享最新一份', async () => {
    let guardrails = '# 角色守则 A'
    const service = makeService(() => guardrails, true)
    const sessionService = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
    const s1 = await sessionService.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'faux' })
    const s2 = await sessionService.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'faux' })
    const selection = { providerId: 'kimi-coding' as const, modelId: 'faux' }

    await service.send(s1.summary.id, '会话一', selection)
    await waitAgentEnd()
    events.length = 0

    guardrails = '# 角色守则 B(最新)'
    await service.send(s2.summary.id, '会话二', selection)
    await waitAgentEnd()

    expect(capturedPrompts[0]).toContain('# 角色守则 A')
    expect(capturedPrompts[1]).toContain('# 角色守则 B(最新)')
  })

  it('会话无绑定(rolePrompt 未注入):提示词只有全局底子', async () => {
    const service = makeService(() => 'x', false)
    const sessionService = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
    const a = await sessionService.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'faux' })
    await service.send(a.summary.id, '你好', { providerId: 'kimi-coding', modelId: 'faux' })
    await waitAgentEnd()
    expect(capturedPrompts[0]).toContain('小柊')
    expect(capturedPrompts[0]).not.toContain('你的角色')
  })
})
