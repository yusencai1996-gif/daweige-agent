import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AgentService, AgentBusyError } from '../../../src/main/agent/agent-service'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { UsageStore } from '../../../src/main/usage/usage-store'
import { UsageService, type UsageRecorder } from '../../../src/main/usage/usage-service'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'
import type { ProviderSelection } from '../../../src/shared/domain/provider'
import { createRoleFixture, type RoleFixture } from '../helpers/role-fixture'

/**
 * M3-04 验证标准:faux Provider 流式单测;中断后状态可恢复;
 * 关闭重启后继续对话不重复消息。
 */

let dir: string
let events: AgentPushEvent[]
let roleFx: RoleFixture

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-agent-'))
  events = []
  roleFx = await createRoleFixture()
})

afterEach(async () => {
  roleFx.close()
  await rm(roleFx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}, 20_000)

interface Ctx {
  agentService: AgentService
  sessionService: SessionService
  repo: SessionRepository
  selection: ProviderSelection
}

async function setup(
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  tokensPerSecond = 10000,
  usageRecorder?: UsageRecorder,
): Promise<Ctx> {
  const faux = fauxProvider({ tokensPerSecond })
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const fauxModel = faux.getModel()

  const repo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
  await repo.init()
  const sessionService = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
  const agentService = new AgentService({
    models: {
      getModel: (_providerId, modelId) => {
        if (modelId !== fauxModel.id) throw new Error(`模型不可用: ${modelId}`)
        return fauxModel
      },
      streamSimple: (model, context, options) => models.streamSimple(model, context, options),
    },
    sessionService,
    emitEvent: (e) => events.push(e),
    usageRecorder,
  })
  return {
    agentService,
    sessionService,
    repo,
    selection: { providerId: 'kimi-coding', modelId: fauxModel.id },
  }
}

async function createSession(ctx: Ctx): Promise<string> {
  const detail = await ctx.sessionService.create({
    roleId: roleFx.roleId,
    providerId: 'kimi-coding',
    modelId: ctx.selection.modelId,
  })
  return detail.summary.id
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('AgentService(faux 流式)', () => {
  it('AgentTurnRunner 可 await 终态,且复用既有事件流与持久化', async () => {
    const ctx = await setup([fauxAssistantMessage('可等待 runner 回复')])
    const sid = await createSession(ctx)

    const result = await ctx.agentService.run({
      sessionId: sid,
      text: '执行 internal turn',
      selection: ctx.selection,
      updateTitle: false,
    })
    expect(result).toMatchObject({
      sessionId: sid,
      status: 'completed',
      finalText: '可等待 runner 回复',
    })
    const types = events.map((event) => event.type)
    expect(types).toContain('message_start')
    expect(types).toContain('message_end')
    expect(types.at(-1)).toBe('agent_end')
    const restored = await ctx.agentService.restoreChatMessages(sid)
    expect(restored.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(restored.filter((message) => message.role === 'assistant')).toHaveLength(1)
    const summaries = await ctx.sessionService.listSummaries()
    expect(summaries.find((summary) => summary.id === sid)?.title).toBe('新会话')
    await ctx.repo.close()
  })

  it('发送 → 流式事件序列 → 持久化 → 恢复不重复', async () => {
    const ctx = await setup([fauxAssistantMessage('好的,我来处理这件事。')])
    const sid = await createSession(ctx)

    const sent = await ctx.agentService.send(sid, '帮我整理文件', ctx.selection)
    expect(sent.role).toBe('user')

    await waitFor(() => events.some((e) => e.type === 'agent_end'))

    // 事件序列:message_start → text_delta* → message_end → agent_end
    const types = events.map((e) => e.type)
    expect(types).toContain('message_start')
    expect(types.filter((t) => t === 'text_delta').length).toBeGreaterThan(0)
    expect(types.indexOf('message_start')).toBeLessThan(types.indexOf('text_delta'))
    expect(types.indexOf('text_delta')).toBeLessThan(types.indexOf('message_end'))
    expect(types.indexOf('message_end')).toBeLessThan(types.indexOf('agent_end'))

    // 会话标题自动更新为首条消息摘要
    const summaries = await ctx.sessionService.listSummaries()
    expect(summaries[0]!.title).toContain('帮我整理文件')

    // 重启(全新 AgentService)恢复:消息齐全且不重复
    ctx.agentService.disposeAgent(sid)
    const restored = await ctx.agentService.restoreChatMessages(sid)
    expect(restored.filter((m) => m.role === 'user')).toHaveLength(1)
    const assistant = restored.find((m) => m.role === 'assistant')
    expect(assistant).toMatchObject({ role: 'assistant', text: '好的,我来处理这件事。' })

    await ctx.repo.close()
  })

  it('连发两条消息:历史累积,agent 上下文连续', async () => {
    const ctx = await setup([
      fauxAssistantMessage('第一问的答复'),
      fauxAssistantMessage('第二问的答复'),
    ])
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '第一问', ctx.selection)
    await waitFor(() => events.filter((e) => e.type === 'agent_end').length >= 1)
    await ctx.agentService.send(sid, '第二问', ctx.selection)
    await waitFor(() => events.filter((e) => e.type === 'agent_end').length >= 2)

    const restored = await ctx.agentService.restoreChatMessages(sid)
    expect(restored.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(restored.filter((m) => m.role === 'assistant')).toHaveLength(2)

    await ctx.repo.close()
  })

  it('正在回复时重复发送 → AgentBusyError(验收 5 不卡死的底层)', async () => {
    const ctx = await setup([fauxAssistantMessage('慢慢说……')], 5)
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '慢点答', ctx.selection)
    await waitFor(() => events.some((e) => e.type === 'message_start'))
    await expect(ctx.agentService.send(sid, '插队', ctx.selection)).rejects.toThrow(AgentBusyError)

    ctx.agentService.abort(sid)
    await ctx.repo.close()
  })

  it('abort 中断后状态可恢复(中断痕迹保留)', async () => {
    const ctx = await setup([fauxAssistantMessage('这条回复很长,会被中途打断……')], 5)
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '开始', ctx.selection)
    await waitFor(() => events.some((e) => e.type === 'text_delta'))
    ctx.agentService.abort(sid)
    await waitFor(() => events.some((e) => e.type === 'agent_end'))

    // 恢复不抛异常,消息历史完整(user 在,assistant 可能有中断痕迹)
    const restored = await ctx.agentService.restoreChatMessages(sid)
    expect(restored.some((m) => m.role === 'user')).toBe(true)

    await ctx.repo.close()
  })

  it('模型不可用时抛 ModelNotReadyError(给 IPC 层翻译成人话)', async () => {
    const ctx = await setup([fauxAssistantMessage('不应到达')])
    const sid = await createSession(ctx)

    await expect(
      ctx.agentService.send(sid, '测试', { ...ctx.selection, modelId: 'bad-model' }),
    ).rejects.toThrow('模型还没准备好')

    await ctx.repo.close()
  })
})

describe('AgentService(使用统计挂钩)', () => {
  /** 挂真实 UsageService 的上下文(usage 库独立于会话库)。 */
  async function setupWithUsage(
    responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  ) {
    const usageEvents: AgentPushEvent[] = []
    const usageStore = new UsageStore(join(dir, 'usage.sqlite'))
    const usageService = new UsageService(usageStore, {
      emitEvent: (e) => usageEvents.push(e),
      iterateMessageEntries: () => [], // 本测试不回填
      logError: () => {},
    })
    const ctx = await setup(responses, 10000, usageService)
    return { ...ctx, usageService, usageStore, usageEvents }
  }

  it('一轮回复:usage 落库 + usage_updated 推送 + dashboard 可见', async () => {
    const ctx = await setupWithUsage([fauxAssistantMessage('统计挂钩测试回复,长度足够产生用量。')])
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '统计测试', ctx.selection)
    await waitFor(() => ctx.usageEvents.some((e) => e.type === 'usage_updated'))

    const dashboard = await ctx.usageService.getDashboard()
    expect(dashboard.hasData).toBe(true)
    expect(dashboard.overview.totalTokens).toBeGreaterThan(0)
    expect(dashboard.models.items).toHaveLength(1)
    // user+assistant 两条消息都进了跨度
    expect(dashboard.overview.longestSessionDurationMs).toBeGreaterThanOrEqual(0)

    await ctx.usageStore.drainAndClose()
    await ctx.repo.close()
  })

  it('recorder 同步抛异常不影响聊天/持久化(usage 只是旁路)', async () => {
    const boom: UsageRecorder = {
      recordAssistantMessage() {
        throw new Error('boom')
      },
      recordMessageSpan() {
        throw new Error('boom')
      },
    }
    const ctx = await setup([fauxAssistantMessage('异常旁路下的正常回复')], 10000, boom)
    const sid = await createSession(ctx)

    const sent = await ctx.agentService.send(sid, '测试', ctx.selection)
    expect(sent.role).toBe('user')
    await waitFor(() => events.some((e) => e.type === 'agent_end'))

    const restored = await ctx.agentService.restoreChatMessages(sid)
    expect(restored.some((m) => m.role === 'assistant')).toBe(true)

    await ctx.repo.close()
  })

  it('历史回填:未挂钩时期写的会话,事后 UsageService 扫出统计且不重复', async () => {
    // 第一阶段:无 usageRecorder 正常聊一轮(模拟旧版本数据)
    const ctx = await setup([fauxAssistantMessage('旧版本时期的回复,回填要能扫到我。')])
    const sid = await createSession(ctx)
    await ctx.agentService.send(sid, '旧消息', ctx.selection)
    await waitFor(() => events.some((e) => e.type === 'agent_end'))
    await ctx.repo.close()

    // 第二阶段:重开仓库,UsageService 回填同一会话库(只读惰性遍历,不开 Session)
    const repo2 = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
    await repo2.init()
    const usageStore = new UsageStore(join(dir, 'usage.sqlite'))
    const usageService = new UsageService(usageStore, {
      emitEvent: () => {},
      iterateMessageEntries: () => repo2.iterateMessageEntries(),
      logError: (msg, err) => console.error('[backfill-test]', msg, err),
    })
    usageService.startBackfill()
    const dashboard = await usageService.getDashboard() // getDashboard 等回填完成
    expect(dashboard.hasData).toBe(true)
    expect(dashboard.overview.totalTokens).toBeGreaterThan(0)

    // 回填幂等:全新 service/store 重跑同一会话库,总量不翻倍(复审测试缺口)
    const usageStore2 = new UsageStore(join(dir, 'usage.sqlite'))
    const usageService2 = new UsageService(usageStore2, {
      emitEvent: () => {},
      iterateMessageEntries: () => repo2.iterateMessageEntries(),
      logError: (msg, err) => console.error('[backfill-test-2]', msg, err),
    })
    usageService2.startBackfill()
    const rerun = await usageService2.getDashboard()
    expect(rerun.overview.totalTokens).toBe(dashboard.overview.totalTokens)
    await usageStore2.drainAndClose()

    await usageStore.drainAndClose()
    await repo2.close()
  })

  it('回填遇坏行只丢自己,不阻断后续行(复审 B-02)', async () => {
    const store = new UsageStore(join(dir, 'usage.sqlite'))
    const at = Date.UTC(2026, 7, 24, 2)
    const poison = {
      get role(): string {
        throw new Error('poison row')
      },
    }
    const good = {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      timestamp: at,
    }
    const errors: string[] = []
    const service = new UsageService(store, {
      emitEvent: () => {},
      iterateMessageEntries: () => [
        { sessionId: 's1', entryId: 'bad', seq: 1, timestamp: at - 1000, message: poison },
        { sessionId: 's1', entryId: 'good', seq: 2, timestamp: at, message: good },
      ],
      logError: (msg) => errors.push(msg),
    })
    service.startBackfill()
    const d = await service.getDashboard()
    // 坏行在前的正常行仍被完整处理
    expect(d.overview.totalTokens).toBe(15)
    expect(d.models.items).toHaveLength(1)
    expect(errors.length).toBe(1)
    await store.drainAndClose()
  })
})
