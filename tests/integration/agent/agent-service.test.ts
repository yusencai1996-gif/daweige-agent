import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from 'typebox'
import {
  AgentService,
  AgentBusyError,
  type AgentServiceDeps,
} from '../../../src/main/agent/agent-service'
import type { CompactionRunner } from '../../../src/main/agent/compaction-service'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { UsageStore } from '../../../src/main/usage/usage-store'
import { UsageService, type UsageRecorder } from '../../../src/main/usage/usage-service'
import { GlobalMemoryStore } from '../../../src/main/memory/global-memory-store'
import { createMemoryPromptProvider } from '../../../src/main/memory/memory-prompt'
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
  models: ReturnType<typeof createModels>
  faux: ReturnType<typeof fauxProvider>
}

async function setup(
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
  tokensPerSecond = 10000,
  usageRecorder?: UsageRecorder,
  compactionService?: CompactionRunner,
  contextWindow?: number,
  toolchain?: AgentServiceDeps['toolchain'],
  extraDeps: Partial<Pick<AgentServiceDeps, 'memoryPrompt' | 'memoryConsolidation' | 'orchestrationPrompt'>> = {},
): Promise<Ctx> {
  const faux = fauxProvider({
    tokensPerSecond,
    ...(contextWindow
      ? { models: [{ id: 'faux-1', contextWindow, maxTokens: 4096 }] }
      : {}),
  })
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
      completeSimple: (model, context, options) => models.completeSimple(model, context, options),
    },
    sessionService,
    emitEvent: (e) => events.push(e),
    usageRecorder,
    ...(compactionService ? { compactionService } : {}),
    ...(toolchain ? { toolchain } : {}),
    ...extraDeps,
  })
  return {
    agentService,
    sessionService,
    repo,
    selection: { providerId: 'kimi-coding', modelId: fauxModel.id },
    models,
    faux,
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

  it('state.json 损坏时 memoryPrompt 零注入降级，ensureAgent 与聊天继续且只诊断一次', async () => {
    const memoryRoot = join(dir, 'broken-memory')
    const memoryStore = new GlobalMemoryStore(memoryRoot)
    await memoryStore.initialize()
    await writeFile(join(memoryRoot, 'state.json'), '{broken-json', 'utf8')
    const diagnostics: string[] = []
    const memoryPrompt = createMemoryPromptProvider(memoryStore, (message) => diagnostics.push(message))
    const ctx = await setup(
      [(context) => {
        expect(String(context.systemPrompt)).not.toContain('记忆使用指南')
        return fauxAssistantMessage('记忆故障不影响聊天')
      }],
      10000,
      undefined,
      undefined,
      undefined,
      undefined,
      { memoryPrompt },
    )
    const sid = await createSession(ctx)
    const result = await ctx.agentService.run({ sessionId: sid, text: '继续聊天', selection: ctx.selection })
    expect(result).toMatchObject({ status: 'completed', finalText: '记忆故障不影响聊天' })
    expect(await memoryPrompt()).toBe('')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('零注入降级')
    await expect(memoryStore.list()).rejects.toThrow()
    await ctx.repo.close()
  })

  it('压缩期间第二次 send 被 busy 门拒绝，abort 同时取消压缩', async () => {
    let started = false
    let aborted = false
    const compaction: CompactionRunner = {
      execute: async (_target, signal) => {
        started = true
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        aborted = true
        throw new DOMException('aborted', 'AbortError')
      },
    }
    const ctx = await setup([fauxAssistantMessage('到达压缩边界')], 10000, undefined, compaction, 10_000)
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '长上下文'.repeat(70_000), ctx.selection)
    await waitFor(() => started)
    expect(ctx.agentService.isSessionBusy(sid)).toBe(true)
    await expect(ctx.agentService.send(sid, '第二条', ctx.selection)).rejects.toThrow(AgentBusyError)

    ctx.agentService.abortSession(sid)
    await waitFor(() => aborted)
    await ctx.agentService.drain()
    await ctx.repo.close()
  })

  it('internal AgentRun 会话即使超阈值也不启用压缩', async () => {
    const execute = vi.fn()
    const mergeStart = vi.fn(async () => {})
    const memoryPrompt = vi.fn(async () => 'INTERNAL_MUST_NOT_SEE_MEMORY')
    const ctx = await setup(
      [(context) => {
        expect(String(context.systemPrompt)).not.toContain('INTERNAL_MUST_NOT_SEE_MEMORY')
        expect(context.tools?.map((tool) => tool.name)).not.toContain('memory.read')
        expect(context.tools?.map((tool) => tool.name)).not.toContain('save_memory')
        return fauxAssistantMessage('内部任务完成')
      }],
      10000,
      undefined,
      { execute },
      undefined,
      async () => ({
        tools: [
          { name: 'memory.read', label: 'read', description: 'read', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) },
          { name: 'save_memory', label: 'save', description: 'save', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) },
        ],
      }),
      { memoryPrompt, memoryConsolidation: { start: mergeStart } },
    )
    const detail = await ctx.sessionService.createInternalSession({
      roleId: roleFx.roleId,
      workspacePath: roleFx.workspaceDir,
      providerId: 'kimi-coding',
      modelId: ctx.selection.modelId,
    })
    const result = await ctx.agentService.run({
      sessionId: detail.summary.id,
      text: '内部长上下文'.repeat(70_000),
      selection: ctx.selection,
      updateTitle: false,
    })
    expect(result.status).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(memoryPrompt).not.toHaveBeenCalled()
    expect(mergeStart).not.toHaveBeenCalled()
    await ctx.repo.close()
  })

  it('工具链在 turn 边界被截停后，压缩成功调用 continue 补出最终结论', async () => {
    const executeCompaction = vi.fn<CompactionRunner['execute']>(async (target) => {
      const tail = target.messages.at(-1)
      expect(tail?.role).toBe('toolResult')
      target.replaceMessages([
        { role: 'compactionSummary', summary: '已执行 echo_tool', tokensBefore: 120_000, timestamp: 10 },
        tail!,
      ])
      return {
        entry: {
          type: 'compaction', id: 'fake-c1', seq: 1, parentId: null, timestamp: 10,
          summary: '已执行 echo_tool', retainedTail: [tail!], tokensBefore: 120_000,
        },
        tokensAfter: 100,
      }
    })
    const ctx = await setup(
      [
        fauxAssistantMessage(fauxToolCall('echo_tool', {})),
        fauxAssistantMessage('工具完成后的最终结论'),
      ],
      10000,
      undefined,
      { execute: executeCompaction },
      10_000,
      async () => ({
        tools: [{
          name: 'echo_tool', label: '回声', description: '测试工具',
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({ content: [{ type: 'text' as const, text: 'echo ok' }], details: {} }),
        }],
      }),
    )
    const sid = await createSession(ctx)
    const result = await ctx.agentService.run({
      sessionId: sid,
      text: '长工具任务'.repeat(70_000),
      selection: ctx.selection,
    })
    expect(result).toMatchObject({ status: 'completed', finalText: '工具完成后的最终结论' })
    expect(executeCompaction).toHaveBeenCalledTimes(1)
    expect(ctx.faux.state.callCount).toBe(2)
    await ctx.repo.close()
  })
})

describe('AgentService(使用统计挂钩)', () => {
  /** 挂真实 UsageService 的上下文(usage 库独立于会话库)。 */
  async function setupWithUsage(
    responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
    contextWindow?: number,
  ) {
    const usageEvents: AgentPushEvent[] = []
    const usageStore = new UsageStore(join(dir, 'usage.sqlite'))
    const usageService = new UsageService(usageStore, {
      emitEvent: (e) => usageEvents.push(e),
      iterateUsageEntries: () => [], // 本测试不回填
      logError: () => {},
    })
    const ctx = await setup(responses, 10000, usageService, undefined, contextWindow)
    return { ...ctx, usageService, usageStore, usageEvents }
  }

  it('memory consolidation auxiliary usage 按 sessionId+sourceId 幂等且归入当前会话/全局', async () => {
    const usageEvents: AgentPushEvent[] = []
    const store = new UsageStore(join(dir, 'aux-usage.sqlite'))
    const service = new UsageService(store, {
      emitEvent: (event) => usageEvents.push(event),
      iterateUsageEntries: () => [],
      logError: () => {},
    })
    const mergeModel = fauxProvider({ provider: 'kimi-coding' }).getModel()
    const input = {
      sourceId: 'memory-merge:7',
      sessionId: 'user-session-1',
      model: mergeModel,
      usage: {
        input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      occurredAt: Date.now(),
      stopReason: 'memory-consolidation' as const,
    }
    await Promise.all([service.recordAuxiliaryUsage(input), service.recordAuxiliaryUsage(input)])
    await waitFor(() => usageEvents.some((event) => event.type === 'usage_updated'))
    const dashboard = await service.getDashboard()
    expect(dashboard.overview.totalTokens).toBe(18)
    expect((await store.getSessionTotals(['user-session-1'])).get('user-session-1')?.totalTokens).toBe(18)
    await store.drainAndClose()
  })

  it('一轮回复:usage 落库 + usage_updated 推送 + dashboard 可见', async () => {
    const ctx = await setupWithUsage([fauxAssistantMessage('统计挂钩测试回复,长度足够产生用量。')])
    const sid = await createSession(ctx)

    await ctx.agentService.send(sid, '统计测试', ctx.selection)
    await waitFor(() => ctx.usageEvents.some((e) => e.type === 'usage_updated'))

    const dashboard = await ctx.usageService.getDashboard()
    expect(dashboard.hasData).toBe(true)
    expect(dashboard.overview.totalTokens).toBeGreaterThan(0)
    expect(dashboard.models.items).toHaveLength(1)
    // 单条 usage event 的活跃时长固定为 0；不再混入 user message 首末跨度。
    expect(dashboard.overview.longestActiveSessionDurationMs).toBe(0)

    await ctx.usageStore.drainAndClose()
    await ctx.repo.close()
  })

  it('recorder 同步抛异常不影响聊天/持久化(usage 只是旁路)', async () => {
    const boom: UsageRecorder = {
      recordAssistantMessage() {
        throw new Error('boom')
      },
      recordCompactionEntry() {},
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
      iterateUsageEntries: () => repo2.iterateUsageEntries(),
      logError: (msg, err) => console.error('[backfill-test]', msg, err),
    })
    usageService.startBackfill()
    const dashboard = await usageService.getDashboard() // getDashboard 等回填完成
    expect(dashboard.hasData).toBe(true)
    expect(dashboard.overview.totalTokens).toBeGreaterThan(0)

    // 回填幂等:全新 service/store 重跑同一会话库,总量不翻倍(codex 复审测试缺口)
    const usageStore2 = new UsageStore(join(dir, 'usage.sqlite'))
    const usageService2 = new UsageService(usageStore2, {
      emitEvent: () => {},
      iterateUsageEntries: () => repo2.iterateUsageEntries(),
      logError: (msg, err) => console.error('[backfill-test-2]', msg, err),
    })
    usageService2.startBackfill()
    const rerun = await usageService2.getDashboard()
    expect(rerun.overview.totalTokens).toBe(dashboard.overview.totalTokens)
    await usageStore2.drainAndClose()

    await usageStore.drainAndClose()
    await repo2.close()
  })

  it('回填遇坏行只丢自己,不阻断后续行(codex 复审 B-02)', async () => {
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
      iterateUsageEntries: () => [
        { type: 'message' as const, sessionId: 's1', entryId: 'bad', seq: 1, timestamp: at - 1000, message: poison },
        { type: 'message' as const, sessionId: 's1', entryId: 'good', seq: 2, timestamp: at, message: good },
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

  it('长会话自动压缩、SQLite 重开恢复摘要，compaction usage live/backfill 幂等', async () => {
    const usagePath = join(dir, 'usage.sqlite')
    const ctx = await setupWithUsage([
      fauxAssistantMessage('本轮先完成'),
      fauxAssistantMessage('## Goal\n保留关键事实：编号 DWG-29。'),
      fauxAssistantMessage('重启后仍按摘要继续'),
    ], 131_072)
    const sid = await createSession(ctx)
    const piSession = await ctx.sessionService.openPiSession(sid)

    // 多个完整 turn：总上下文超 80%，同时保证 pi 能按 turn 边界保留约 20k tail。
    for (let i = 0; i < 14; i++) {
      await piSession.appendMessage({
        role: 'user', content: `历史问题${i}:DWG-29:` + '甲'.repeat(20_000), timestamp: i * 2 + 1,
      })
      const historical = fauxAssistantMessage(`历史答复${i}:` + '乙'.repeat(20_000), {
        timestamp: i * 2 + 2,
      })
      // fauxAssistantMessage 会带 errorMessage/deferred 等 undefined 字段,pi 落库严格 JSON 校验会拒;剥掉
      await piSession.appendMessage(JSON.parse(JSON.stringify(historical)) as typeof historical)
    }

    const result = await ctx.agentService.run({
      sessionId: sid,
      text: '请记住编号并继续',
      selection: ctx.selection,
    })
    expect(result.status).toBe('completed')
    await waitFor(() => events.some((event) => event.type === 'context_compacted'))
    await waitFor(() => ctx.usageEvents.filter((event) => event.type === 'usage_updated').length >= 2)

    const entries = await piSession.findEntriesOnBranch({ order: 'oldestFirst' })
    const compactions = entries.filter((entry) => entry.type === 'compaction')
    expect(compactions).toHaveLength(1)
    const restoredUi = await ctx.agentService.restoreChatMessages(sid)
    expect(restoredUi.some((message) => message.kind === 'compaction')).toBe(true)
    expect(restoredUi.filter((message) => message.kind === 'chat').length).toBeGreaterThan(20)

    const liveDb = new DatabaseSync(usagePath, { readOnly: true })
    const liveCount = Number((liveDb.prepare(
      `SELECT COUNT(*) AS count FROM usage_events WHERE stop_reason = 'compaction'`,
    ).get() as { count: number }).count)
    liveDb.close()
    expect(liveCount).toBe(1)

    // 真关闭旧 repository，再用新实例打开；模型收到的必须是摘要+tail，不是全部原历史。
    ctx.agentService.disposeAgent(sid)
    await ctx.repo.close()
    const repo2 = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
    await repo2.init()
    const sessionService2 = new SessionService(repo2, roleFx.roleRepository, roleFx.roleService)
    let restartContext: readonly unknown[] = []
    const service2 = new AgentService({
      models: {
        getModel: () => ctx.faux.getModel(),
        streamSimple: (model, context, options) => {
          restartContext = context.messages
          return ctx.models.streamSimple(model, context, options)
        },
        completeSimple: (model, context, options) => ctx.models.completeSimple(model, context, options),
      },
      sessionService: sessionService2,
      emitEvent: () => {},
    })
    const restart = await service2.run({
      sessionId: sid,
      text: '重启后继续',
      selection: ctx.selection,
    })
    expect(restart.status).toBe('completed')
    // compactionSummary 经 convertToLlm 转成承载摘要文本的 user 消息(见 agent-service convertToLlm);
    // 断言摘要事实(DWG-29)真的发给了模型——这是"重启后按摘要继续"的实质。
    expect(
      restartContext.some((message) => {
        const m = message as { role?: string; content?: unknown }
        return m.role === 'user' && typeof m.content === 'string' && m.content.includes('DWG-29')
      }),
    ).toBe(true)
    expect(restartContext.length).toBeLessThan(entries.filter((entry) => entry.type === 'message').length)

    // 关闭 live store 后重扫同一 sessions.sqlite，幂等主键保证 compaction 仍恰一条。
    await ctx.usageService.drainAndClose()
    const backfillStore = new UsageStore(usagePath)
    const backfillService = new UsageService(backfillStore, {
      emitEvent: () => {},
      iterateUsageEntries: () => repo2.iterateUsageEntries(),
      logError: (message, error) => console.error(message, error),
    })
    backfillService.startBackfill()
    await backfillService.getDashboard()
    const verifyDb = new DatabaseSync(usagePath, { readOnly: true })
    const afterBackfill = Number((verifyDb.prepare(
      `SELECT COUNT(*) AS count FROM usage_events WHERE stop_reason = 'compaction'`,
    ).get() as { count: number }).count)
    verifyDb.close()
    expect(afterBackfill).toBe(1)

    await backfillService.drainAndClose()
    service2.disposeAgent(sid)
    await repo2.close()
  }, 30_000)
})
