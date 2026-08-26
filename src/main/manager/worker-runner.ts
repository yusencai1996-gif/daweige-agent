import type { DelegationEnvelope, DelegationResult } from '../../shared/domain/manager'
import type { ProviderSelection } from '../../shared/domain/provider'
import type {
  AgentTurnResult,
  AgentTurnRunner,
} from '../agent/agent-service'
import { renderDelegationTaskInstruction } from '../agent/prompt-composer'
import type { DelegationPathViolation } from '../files/path-policy'
import { StrictDelegationPathPolicy } from '../files/path-policy'
import { buildDelegationResult } from './delegation-result'

export interface WorkerRunInput {
  readonly sessionId: string
  readonly selection: ProviderSelection
  readonly envelope: DelegationEnvelope
  readonly policy: StrictDelegationPathPolicy
  /** 终态后从主进程 run 现场读取,避免启动前快照丢掉执行期记录。 */
  readonly loadBoundaryViolations: () => Promise<readonly DelegationPathViolation[]>
}

export interface WorkerRunResult {
  readonly turn: AgentTurnResult
  readonly result: DelegationResult | null
}

/**
 * internal session 的单回合可等待运行器。不实现 pi 细节,
 * 只复用 AgentTurnRunner 的单一生产适配器。
 */
export class WorkerRunner {
  private accepting = true

  constructor(private readonly runner: AgentTurnRunner) {}

  async run(input: WorkerRunInput): Promise<WorkerRunResult> {
    if (!this.accepting) throw new Error('应用正在退出，不能再启动内部任务')
    const turn = await this.runner.run({
      sessionId: input.sessionId,
      selection: input.selection,
      text: renderDelegationTaskInstruction(input.envelope),
      updateTitle: false,
    })
    if (turn.status !== 'completed') return { turn, result: null }
    const boundaryViolations = await input.loadBoundaryViolations()
    const result = await buildDelegationResult({
      finalText: turn.finalText,
      acceptanceCriteria: input.envelope.acceptanceCriteria,
      policy: input.policy,
      boundaryViolations,
    })
    return { turn, result }
  }

  abortSession(sessionId: string): void {
    this.runner.abortSession(sessionId)
  }

  stopAccepting(): void {
    this.accepting = false
  }
}
