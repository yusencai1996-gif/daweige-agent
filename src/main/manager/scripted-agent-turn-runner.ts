import type { AgentTurnInput, AgentTurnResult, AgentTurnRunner } from '../agent/agent-service'

/** 仅供双门 E2E 组合根使用；生产包永远不会实例化。 */
export class ScriptedAgentTurnRunner implements AgentTurnRunner {
  private readonly aborted = new Set<string>()

  constructor(
    private readonly scenario: 'manager-happy' | 'manager-boundary' | 'manager-crash',
    private readonly recordBoundary?: (sessionId: string) => Promise<void>,
    private readonly recordTranscript?: (
      input: AgentTurnInput,
      finalText: string,
    ) => Promise<void>,
  ) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    await new Promise((resolve) => setImmediate(resolve))
    if (this.aborted.delete(input.sessionId)) {
      return { sessionId: input.sessionId, status: 'aborted', finalText: '' }
    }
    if (this.scenario === 'manager-crash') {
      return new Promise(() => {})
    }
    if (this.scenario === 'manager-boundary') await this.recordBoundary?.(input.sessionId)
    const summary = this.scenario === 'manager-boundary'
      ? '已阻止越界操作，未写入允许目录外的文件'
      : '已按任务简报完成处理'
    const finalText = `<daweige-delegation-result version="1">\n${JSON.stringify({ summary, conclusions: [summary], artifactPaths: [], unmetCriteria: [] })}\n</daweige-delegation-result>`
    await this.recordTranscript?.(input, finalText)
    return {
      sessionId: input.sessionId,
      status: 'completed',
      finalText,
    }
  }

  abortSession(sessionId: string): void {
    this.aborted.add(sessionId)
  }
}
