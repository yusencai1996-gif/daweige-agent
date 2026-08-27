import type { FrameTransport, HelperFrame } from './sandbox-process-host'

/**
 * 沙箱执行器接口(0.4.0 C3)。
 * 生产=FramedSandboxExecutor(驱动真 helper);测试/E2E=FakeSandboxExecutor(注入假帧)。
 * 红线:任何实现都不得绕过沙箱宿主直接跑用户命令;
 * helper 不可用=SandboxUnavailableError,调用方 fail-closed 拒绝,无裸跑分支。
 */

export interface SandboxRunInput {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly writableRoots: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly capabilitySid: string
}

export interface SandboxRunEvents {
  /** 实时输出(stdout/stderr 各自维护 sequence)。 */
  readonly onOutput: (stream: 'stdout' | 'stderr', sequence: number, text: string) => void
}

export interface SandboxRunResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** helper 侧被 cancel 帧终止(AbortSignal→cancel→spawn_exited.cancelled)。 */
  readonly cancelled: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface SandboxExecutor {
  run(input: SandboxRunInput, events: SandboxRunEvents, signal?: AbortSignal): Promise<SandboxRunResult>
}

/** 每流保留上限(超出继续排空管道但标记 truncated)。 */
const STREAM_CAP_BYTES = 1024 * 1024

/** 生产实现:帧传输驱动真 helper。transport 由宿主在启动时建立并复用。 */
export class FramedSandboxExecutor implements SandboxExecutor {
  constructor(
    private readonly transport: FrameTransport,
    private readonly envForSpawn: (capSid: string) => Record<string, string>,
  ) {}

  async run(
    input: SandboxRunInput,
    events: SandboxRunEvents,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    const id = Math.floor(Math.random() * 1_000_000) + 1
    const started = Date.now()

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let settle: ((r: SandboxRunResult) => void) | undefined
    let unlisten: (() => void) | undefined

    const result = new Promise<SandboxRunResult>((resolve) => {
      settle = resolve
      unlisten = this.transport.onFrame((frame: HelperFrame) => {
        if (frame.type === 'output' && frame.id === id) {
          const text = decodeB64(frame.data_b64)
          if (frame.stream === 'stdout') {
            if (stdout.length < STREAM_CAP_BYTES) {
              stdout += text
              if (stdout.length > STREAM_CAP_BYTES) stdoutTruncated = true
            } else {
              stdoutTruncated = true
            }
            events.onOutput('stdout', frame.sequence, text)
          } else {
            if (stderr.length < STREAM_CAP_BYTES) {
              stderr += text
              if (stderr.length > STREAM_CAP_BYTES) stderrTruncated = true
            } else {
              stderrTruncated = true
            }
            events.onOutput('stderr', frame.sequence, text)
          }
        } else if (frame.type === 'spawn_exited' && frame.id === id) {
          settle?.({
            exitCode: frame.exit_code,
            timedOut: frame.timed_out,
            cancelled: frame.cancelled,
            durationMs: frame.duration_ms,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
          })
        } else if (frame.type === 'error' && frame.id === id) {
          settle?.({
            exitCode: null,
            timedOut: false,
            cancelled: false,
            durationMs: Date.now() - started,
            stdout,
            stderr: `${stderr}${stderr ? '\n' : ''}${frame.message}`,
            stdoutTruncated,
            stderrTruncated,
          })
        }
      })

      // 发起
      const env = { ...this.envForSpawn(input.capabilitySid), ...input.env }
      this.transport.send({
        type: 'spawn',
        id,
        command: input.command,
        cwd: input.cwd,
        timeout_ms: input.timeoutMs,
        writable_roots: [...input.writableRoots],
        env,
      })
    })

    signal?.addEventListener(
      'abort',
      () => {
        this.transport.send({ type: 'cancel', id })
      },
      { once: true },
    )

    try {
      return await result
    } finally {
      unlisten?.()
    }
  }
}

/**
 * 假执行器(测试/E2E 专用;双门保护同 0.3 E2E 纪律——生产装配绝不注入)。
 * 脚本映射:命令原文 → 结果;未映射命令走保守拒绝。
 */
export class FakeSandboxExecutor implements SandboxExecutor {
  private readonly scripts = new Map<string, Partial<SandboxRunResult> & { output?: string; errOutput?: string }>()
  public readonly ran: readonly { command: string; cwd: string; roots: readonly string[] }[] = []

  script(command: string, result: Partial<SandboxRunResult> & { output?: string; errOutput?: string }): this {
    this.scripts.set(command, result)
    return this
  }

  async run(
    input: SandboxRunInput,
    events: SandboxRunEvents,
    _signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    ;(this.ran as { command: string; cwd: string; roots: readonly string[] }[]).push({
      command: input.command,
      cwd: input.cwd,
      roots: input.writableRoots,
    })
    const script = this.scripts.get(input.command)
    const started = Date.now()
    if (!script) {
      return {
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
        stdout: '',
        stderr: 'FakeSandbox: 未脚本化的命令,保守拒绝',
        stdoutTruncated: false,
        stderrTruncated: false,
      }
    }
    if (script.output) events.onOutput('stdout', 0, script.output)
    if (script.errOutput) events.onOutput('stderr', 0, script.errOutput)
    return {
      exitCode: script.exitCode ?? 0,
      timedOut: script.timedOut ?? false,
      cancelled: script.cancelled ?? false,
      durationMs: script.durationMs ?? Date.now() - started,
      stdout: script.output ?? script.stdout ?? '',
      stderr: script.errOutput ?? script.stderr ?? '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }
  }
}

function decodeB64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}
