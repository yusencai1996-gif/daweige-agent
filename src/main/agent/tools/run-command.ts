import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { realpath } from 'node:fs/promises'
import type { ApprovalBroker } from '../approval-broker'
import type { CommandApprovalCache } from '../../command/command-approval-cache'
import { decideExecPolicy } from '../../command/exec-policy'
import type { SandboxExecutor } from '../../sandbox/executor'
import type { SandboxUnavailableError } from '../../sandbox/sandbox-process-host'
import type { CommandResultDetails, SandboxProfileSnapshot } from '../../../shared/domain/command'
import type { PathPolicy } from '../../files/path-policy'

/**
 * run_command 工具(0.4.0 C3)——命令执行的唯一入口编排:
 * 参数校验 → ExecPolicy 三级决策 → (prompt)审批卡/(allow)白名单/(forbidden)直接拒
 * → 精确缓存复用 → SandboxExecutor(真 helper 或测试 fake)→ 结构化结果回模型。
 *
 * 红线:
 * - 任何失败(审批拒绝/超时/沙箱不可用)都以 block 错误回模型,绝不伪造成 success;
 * - 工具内不直接启动子进程(那是 sandbox-process-host 的专属);
 * - allow 只免卡,仍过沙箱。
 */

const Params = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: 16_384,
      description: '要运行的 PowerShell 命令原文(将原样展示给用户确认后执行)',
    }),
    cwd: Type.Optional(
      Type.String({ description: '工作目录(绝对路径,必须在允许写的文件夹内);缺省用会话工作区' }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({ minimum: 1_000, maximum: 300_000, description: '超时毫秒数,缺省 120000(2 分钟)' }),
    ),
  },
  { additionalProperties: false },
)

export interface RunCommandToolDeps {
  /** 授权 owner 会话(child internal 各自独立;surface=manager 用户会话)。 */
  readonly sessionId: string
  readonly surfaceSessionId?: string
  readonly broker: ApprovalBroker
  readonly cache: CommandApprovalCache
  readonly executor: SandboxExecutor
  /** 该会话的写根(realpath 快照;strict delegation 的 frozen roots)。 */
  readonly writableRoots: readonly string[]
  /** 会话缺省 cwd(realpath 后)。 */
  readonly defaultCwd: string
  /** capability SID(工作区钥匙;host 侧 cap store 生成)。 */
  readonly capabilitySid: string
  /** 每回合的 approvalScopeId(turn 粘性缓存的键空间)。 */
  readonly approvalScopeId: () => string
  /** run 级 scope(delegated run 的 runId/manager 工作区 revision);普通会话为空。 */
  readonly scopeId: string
  /** 输出实时推送(推 renderer 的 command_output 事件;toolCallId 由 execute 现场传入以关联卡片)。 */
  readonly onOutput: (
    toolCallId: string,
    stream: 'stdout' | 'stderr',
    sequence: number,
    text: string,
  ) => void
  /**
   * 命令跑完的终值摘要(推 renderer 的 command_finished 事件;不含 stdout/stderr——
   * 完整流已在 command_output 里,renderer 自行合成;只有真正执行过才调用,
   * 审批拒绝/forbidden/沙箱不可用等未执行路径不调用)。
   */
  readonly onFinished: (
    toolCallId: string,
    result: Omit<CommandResultDetails, 'stdout' | 'stderr'>,
  ) => void
  readonly signal?: AbortSignal
  /** delegated run 的 path policy(显式 cwd 越界直接拒,不弹卡)。 */
  readonly strictPolicy?: PathPolicy
  /**
   * 工作区租约门(0.4.0 D,普通/manager 会话专用):写根被活跃派活租约占用时抛人话错误。
   * delegated run 不接(自己就是租约方,互斥在启动时已保证)。
   */
  readonly assertNotLeased?: () => Promise<void>
}

export function createRunCommandTool(deps: RunCommandToolDeps): AgentTool<typeof Params> {
  return {
    name: 'run_command',
    label: '运行命令',
    description:
      '在沙箱里运行一条 PowerShell 命令(读全盘、只写允许的文件夹、超时可设)。危险命令会被直接拒绝;其余命令会弹卡让用户确认。',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (id0, params: Static<typeof Params>, signal?: AbortSignal) => {
      // pi 在用户停止/回合中止时会 abort 在途工具:优先用 pi 的 signal(接通停止按钮→helper cancel 帧);
      // deps.signal 保留给不走 pi 回合的调用方(如未来调度器直跑)
      const abortSignal = signal ?? deps.signal
      const command = params.command.trim()
      const timeoutMs = params.timeoutMs ?? 120_000

      // 1) cwd 解析与校验
      const cwdRequested = params.cwd?.trim() || deps.defaultCwd
      let realCwd: string
      try {
        realCwd = await realpath(cwdRequested)
      } catch {
        throw new Error(`工作目录不存在:${cwdRequested}`)
      }
      const insideRoot = deps.writableRoots.some(
        (root) => realCwd === root || realCwd.startsWith(`${root}\\`) || realCwd.startsWith(`${root}/`),
      )
      if (!insideRoot) {
        if (deps.strictPolicy) {
          // delegated run:越界 cwd 直接拒,不弹卡(PLAN §5.1)
          throw new Error('工作目录不在这次任务允许的文件夹里,已拒绝。')
        }
        throw new Error('工作目录不在允许写的文件夹里。')
      }

      // 1.5) 工作区租约门(普通/manager 会话):被派活占用的根直接拒,不弹卡(阶段复审阻断整改)
      if (deps.assertNotLeased) {
        await deps.assertNotLeased()
      }

      // 2) 策略三级决策
      const verdict = decideExecPolicy(command)
      if (verdict.decision === 'forbidden') {
        throw new Error(`这条命令被安全策略直接拒绝:${verdict.reason}`)
      }

      const sandbox: SandboxProfileSnapshot = {
        level: 'restricted-token',
        readable: 'all-local-files',
        writableRoots: deps.writableRoots,
        network: 'not-isolated',
      }

      const cacheKey = {
        ownerSessionId: deps.sessionId,
        command,
        realCwd,
        timeoutMs,
        sandboxLevel: sandbox.level,
        writableRoots: deps.writableRoots,
        scopeId: deps.scopeId,
      }

      // 3) prompt 档:先查精确缓存,未命中弹卡
      if (verdict.decision === 'prompt') {
        const alreadyTurn = deps.cache.hasTurnGrant(deps.approvalScopeId(), cacheKey)
        const alreadySession = deps.cache.hasSessionGrant(cacheKey)
        if (!alreadyTurn && !alreadySession) {
          const outcome = await deps.broker.requestCommand({
            sessionId: deps.sessionId,
            surfaceSessionId: deps.surfaceSessionId,
            title: '我要运行一条命令',
            description: `${verdict.reason}。命令将在沙箱里执行:读全盘、只写允许的文件夹;本版未隔离网络。`,
            command,
            cwd: realCwd,
            timeoutMs,
            sandbox,
            reason: verdict.reason,
            toolCallId: id0,
          })
          if (outcome.decision === 'reject') {
            throw new Error(
              outcome.note?.trim()
                ? `用户没有批准这条命令:${outcome.note.trim()}`
                : '用户没有批准这条命令。请调整做法或向用户解释清楚再试。',
            )
          }
          // turn 档本会话刻意关闭(approvalScopeId 每次随机,永不命中):scope 传 undefined 跳过
          // turn 登记,防 turnGrants 无界泄漏;approve-session 的 session 档登记不受影响
          deps.cache.recordDecision(undefined, cacheKey, outcome.decision)
        }
      }
      // allow 档:不弹卡不写缓存,直接执行(仍过沙箱)

      // 3.5) 批准后复检租约(终验·TOCTOU):等用户确认的窗口里 delegated run
      // 可能恰好拿到同根租约——批准/allow 都不能绕过互斥,执行前最后核一次
      if (deps.assertNotLeased) {
        await deps.assertNotLeased()
      }

      // 4) 执行
      let result
      try {
        result = await deps.executor.run(
          {
            command,
            cwd: realCwd,
            timeoutMs,
            writableRoots: deps.writableRoots,
            env: {},
            capabilitySid: deps.capabilitySid,
          },
          { onOutput: (stream, sequence, text) => deps.onOutput(id0, stream, sequence, text) },
          abortSignal,
        )
      } catch (err) {
        if ((err as Error).name === 'SandboxUnavailableError') {
          throw new Error(
            `安全执行器不可用,这条命令没有运行:${(err as SandboxUnavailableError).message}`,
          )
        }
        throw err
      }

      const details: CommandResultDetails = {
        command,
        cwd: realCwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      }
      // 终值摘要与 details 同源构造(唯一差别=不带 stdout/stderr),防两份手写漂移
      const { stdout, stderr, ...finishedSummary } = details
      void stdout
      void stderr
      deps.onFinished(id0, finishedSummary)

      // 5) 非零退出/超时/取消如实回模型(不伪装成功)
      const outcomeLine = result.cancelled
        ? '命令被用户停止了,已收到的输出如下。'
        : result.timedOut
          ? `命令超时被终止(${Math.round(result.durationMs / 1000)} 秒)。`
          : result.exitCode === 0
            ? `命令完成,退出码 0,耗时 ${Math.round(result.durationMs / 1000)} 秒。`
            : `命令失败,退出码 ${result.exitCode}。`

      const stdoutPreview = clip(result.stdout, 8_000)
      const stderrPreview = clip(result.stderr, 4_000)

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              outcomeLine,
              stdoutPreview ? `--- stdout ---\n${stdoutPreview}` : '(无 stdout)',
              stderrPreview ? `--- stderr ---\n${stderrPreview}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        details,
      }
    },
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...(输出过长已截断,共 ${text.length} 字符)`
}
