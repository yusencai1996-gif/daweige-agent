import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentTurnInput, AgentTurnRunner } from '../../../src/main/agent/agent-service'
import { StrictDelegationPathPolicy } from '../../../src/main/files/path-policy'
import { WorkerRunner } from '../../../src/main/manager/worker-runner'

let temp: string | undefined
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {})
  temp = undefined
})

describe('WorkerRunner', () => {
  it('在 internal session 跑一次任务指令并解析结果', async () => {
    temp = await mkdtemp(join(tmpdir(), 'daweige-worker-runner-'))
    const allowed = join(temp, 'allowed')
    const appData = join(temp, 'userData')
    await Promise.all([mkdir(allowed), mkdir(appData)])
    let captured: AgentTurnInput | undefined
    const fake: AgentTurnRunner = {
      async run(input) {
        captured = input
        return {
          sessionId: input.sessionId,
          status: 'completed',
          finalText:
            '<daweige-delegation-result version="1">\n' +
            JSON.stringify({ summary: '做完了', conclusions: [], artifactPaths: [], unmetCriteria: [] }) +
            '\n</daweige-delegation-result>',
        }
      },
      abortSession() {},
    }
    const runner = new WorkerRunner(fake)
    const output = await runner.run({
      sessionId: 'internal-1',
      selection: { providerId: 'kimi-coding', modelId: 'faux' },
      envelope: {
        userRequest: '整理文件',
        managerConclusions: [],
        taskBrief: '按月分类',
        acceptanceCriteria: ['分类完成'],
        allowedWorkspacePaths: [allowed],
      },
      policy: new StrictDelegationPathPolicy([allowed], appData),
      loadBoundaryViolations: async () => [],
    })
    expect(captured).toMatchObject({ sessionId: 'internal-1', updateTitle: false })
    expect(captured?.text).toContain('按月分类')
    expect(output.result).toMatchObject({ summary: '做完了', unmetCriteria: [] })
  })

  it('runner 失败时不伪造完成 result', async () => {
    const fake: AgentTurnRunner = {
      async run(input) {
        return { sessionId: input.sessionId, status: 'failed', finalText: '', errorMessage: '模型错误' }
      },
      abortSession() {},
    }
    temp = await mkdtemp(join(tmpdir(), 'daweige-worker-runner-fail-'))
    const allowed = join(temp, 'allowed')
    const appData = join(temp, 'userData')
    await Promise.all([mkdir(allowed), mkdir(appData)])
    const output = await new WorkerRunner(fake).run({
      sessionId: 'internal-2',
      selection: { providerId: 'kimi-coding', modelId: 'faux' },
      envelope: {
        userRequest: 'x', managerConclusions: [], taskBrief: 'x',
        acceptanceCriteria: ['x'], allowedWorkspacePaths: [allowed],
      },
      policy: new StrictDelegationPathPolicy([allowed], appData),
      loadBoundaryViolations: async () => [],
    })
    expect(output.result).toBeNull()
    expect(output.turn.status).toBe('failed')
  })
})
