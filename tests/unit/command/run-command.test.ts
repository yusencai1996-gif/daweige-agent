import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { CommandApprovalCache } from '../../../src/main/command/command-approval-cache'
import { createRunCommandTool } from '../../../src/main/agent/tools/run-command'
import { FakeSandboxExecutor } from '../../../src/main/sandbox/executor'

let broker: ApprovalBroker
let cache: CommandApprovalCache
let executor: FakeSandboxExecutor
let events: AgentPushEvent[]
let root: string
let realRoot: string

beforeEach(async () => {
  events = []
  broker = new ApprovalBroker((e) => events.push(e))
  cache = new CommandApprovalCache()
  executor = new FakeSandboxExecutor()
  root = mkdtempSync(join(tmpdir(), 'run-cmd-'))
  realRoot = await realpath(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeTool(over: Partial<Parameters<typeof createRunCommandTool>[0]> = {}) {
  return createRunCommandTool({
    sessionId: 'sess-A',
    broker,
    cache,
    executor,
    writableRoots: [realRoot],
    defaultCwd: realRoot,
    capabilitySid: 'S-1-5-80-1-1-1-1-1',
    approvalScopeId: () => 'turn-1',
    scopeId: '',
    onOutput: () => {},
    onFinished: () => {},
    ...over,
  })
}

/** 模拟用户批准当前待决命令卡。 */
async function approvePending(decision: 'approve' | 'reject' = 'approve') {
  const card = [...events].reverse().find((e) => e.type === 'approval_required')
  if (!card || card.type !== 'approval_required') throw new Error('没有待决卡')
  broker.resolve({ approvalId: card.request.id, decision })
}

async function waitForCard(evts: AgentPushEvent[], timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (evts.some((e) => e.type === 'approval_required')) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('等卡超时')
}

describe('run_command 工具编排', () => {
  it('forbidden 命令直接拒,不出卡不执行', async () => {
    const tool = makeTool()
    await expect(tool.execute('c1', { command: 'format d:' } as never)).rejects.toThrow('安全策略')
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0)
    expect(executor.ran).toHaveLength(0)
  })

  it('prompt 命令:弹卡→批准→执行成功回传', async () => {
    executor.script('python summarize.py', { output: '合计 42 行', exitCode: 0 })
    const tool = makeTool()
    const pending = tool.execute('c1', { command: 'python summarize.py' } as never)
    await waitForCard(events)
    await approvePending('approve')
    const result = await pending
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('退出码 0')
    expect(text).toContain('合计 42 行')
    expect(executor.ran).toHaveLength(1)
    expect(executor.ran[0]?.cwd).toBe(realRoot)
  })

  it('prompt 命令:用户拒绝→block 回模型,不执行', async () => {
    const tool = makeTool()
    const pending = tool.execute('c1', { command: 'python bad.py' } as never)
    await waitForCard(events)
    await approvePending('reject')
    await expect(pending).rejects.toThrow('没有批准')
    expect(executor.ran).toHaveLength(0)
  })

  it('allow 白名单命令免卡直接执行(仍过沙箱)', async () => {
    executor.script('whoami', { output: 'desktop\\demo' })
    const tool = makeTool()
    await tool.execute('c1', { command: 'whoami' } as never)
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(0)
    expect(executor.ran).toHaveLength(1)
  })

  it('单次 approve 后同命令再跑仍会问(turn 档一期关闭防泄漏;免卡只经 approve-session)', async () => {
    executor.script('python summarize.py', { output: 'ok' })
    const tool = makeTool()
    const first = tool.execute('c1', { command: 'python summarize.py' } as never)
    await waitForCard(events)
    await approvePending('approve')
    await first
    const cardsBefore = events.filter((e) => e.type === 'approval_required').length
    // 生产装配 approvalScopeId 每次随机(保守决策),recordDecision 跳过 turn 登记:
    // 单次 approve 只放行当次,同命令第二次照常弹卡(宁多问不放大授权)
    const second = tool.execute('c2', { command: 'python summarize.py' } as never)
    const start = Date.now()
    while (
      events.filter((e) => e.type === 'approval_required').length <= cardsBefore &&
      Date.now() - start < 3000
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(events.filter((e) => e.type === 'approval_required').length).toBe(cardsBefore + 1)
    await approvePending('reject')
    await expect(second).rejects.toThrow('没有批准')
  })

  it('非零退出码如实回传不伪装成功', async () => {
    executor.script('python fail.py', { exitCode: 2, errOutput: 'boom' })
    const tool = makeTool()
    const pending = tool.execute('c1', { command: 'python fail.py' } as never)
    await waitForCard(events)
    await approvePending('approve')
    const result = await pending
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain('退出码 2')
    expect(text).toContain('boom')
  })

  it('cwd 越界直接拒绝不弹卡', async () => {
    const tool = makeTool()
    await expect(
      tool.execute('c1', { command: 'whoami', cwd: 'C:\\Windows' } as never),
    ).rejects.toThrow('不在')
    expect(executor.ran).toHaveLength(0)
  })

  it('命令卡 kind=command 且带沙箱快照(网络如实标注)', async () => {
    const tool = makeTool()
    const pending = tool.execute('c1', { command: 'python a.py' } as never)
    await waitForCard(events)
    const card = events.find((e) => e.type === 'approval_required')
    expect(card && card.type === 'approval_required' && card.request.kind === 'command').toBe(true)
    if (card && card.type === 'approval_required' && card.request.kind === 'command') {
      expect(card.request.sandbox.network).toBe('not-isolated')
      expect(card.request.sandbox.writableRoots).toEqual([realRoot])
      expect(card.request.command).toBe('python a.py')
    }
    await approvePending('approve')
    await pending
  })

  it('执行成功:onFinished 收终值摘要(无 stdout/stderr),卡带真实 toolCallId', async () => {
    executor.script('python summarize.py', { output: 'ok', exitCode: 0 })
    const finished: Array<{ toolCallId: string; result: Record<string, unknown> }> = []
    const tool = makeTool({
      onFinished: (toolCallId, result) => finished.push({ toolCallId, result: { ...result } }),
    })
    const pending = tool.execute('call-xyz', { command: 'python summarize.py' } as never)
    await waitForCard(events)
    // 卡的 request.toolCallId 必须是真实工具调用 id(前端按它翻卡终态;曾传空串导致卡停在"执行中")
    const card = events.find((e) => e.type === 'approval_required')
    expect(
      card && card.type === 'approval_required' && card.request.kind === 'command'
        ? card.request.toolCallId
        : '(无卡)',
    ).toBe('call-xyz')
    await approvePending('approve')
    await pending
    expect(finished).toHaveLength(1)
    expect(finished[0]?.toolCallId).toBe('call-xyz')
    expect(finished[0]?.result).not.toHaveProperty('stdout')
    expect(finished[0]?.result).not.toHaveProperty('stderr')
    expect(finished[0]?.result).toMatchObject({ command: 'python summarize.py', exitCode: 0 })
  })

  it('未执行路径(拒绝/forbidden)不调用 onFinished', async () => {
    const finished: unknown[] = []
    const tool = makeTool({
      onFinished: (...args) => finished.push(args),
    })
    await expect(tool.execute('c1', { command: 'format d:' } as never)).rejects.toThrow()
    const pending = tool.execute('c2', { command: 'python bad.py' } as never)
    await waitForCard(events)
    await approvePending('reject')
    await expect(pending).rejects.toThrow()
    expect(finished).toHaveLength(0)
  })

  it('approve-session:同命令本会话内不再弹卡(初审 90% 整改回归)', async () => {
    executor.script('python summarize.py', { output: 'ok' })
    const tool = makeTool()
    const first = tool.execute('c1', { command: 'python summarize.py' } as never)
    await waitForCard(events)
    // 点「本会话允许这条相同命令」
    const card = events.find((e) => e.type === 'approval_required')
    if (!card || card.type !== 'approval_required') throw new Error('没有卡')
    broker.resolve({ approvalId: card.request.id, decision: 'approve-session' })
    await first
    const cardsAfterFirst = events.filter((e) => e.type === 'approval_required').length
    // 第二次完全相同命令:不弹卡直接执行
    await tool.execute('c2', { command: 'python summarize.py' } as never)
    expect(events.filter((e) => e.type === 'approval_required').length).toBe(cardsAfterFirst)
    expect(executor.ran).toHaveLength(2)
    // 换一条命令仍要弹卡(精确键,不是全放行)
    const third = tool.execute('c3', { command: 'python other.py' } as never)
    const start = Date.now()
    while (
      events.filter((e) => e.type === 'approval_required').length <= cardsAfterFirst &&
      Date.now() - start < 3000
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(events.filter((e) => e.type === 'approval_required').length).toBe(cardsAfterFirst + 1)
    await approvePending('reject')
    await expect(third).rejects.toThrow('没有批准')
  })

  it('pi 的 AbortSignal 传到沙箱执行器(停止按钮→helper cancel 帧接线;复审阻断项回归)', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const abortableExecutor = {
      async run(
        _input: unknown,
        events: { onOutput: (s: 'stdout' | 'stderr', q: number, t: string) => void },
        signal?: AbortSignal,
      ) {
        seen.push(signal)
        // 模拟长命令:等 abort 到达再返回取消语义
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
          setTimeout(resolve, 2000)
        })
        events.onOutput('stdout', 0, 'partial')
        return {
          exitCode: null,
          timedOut: false,
          durationMs: 10,
          stdout: 'partial',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      },
    } as unknown as typeof executor
    const tool = makeTool({ executor: abortableExecutor })
    const controller = new AbortController()
    const pending = tool.execute('c1', { command: 'python long.py' } as never, controller.signal)
    await waitForCard(events)
    await approvePending('approve')
    setTimeout(() => controller.abort(), 30)
    await pending
    expect(seen[0]?.aborted).toBe(true)
  })
})
