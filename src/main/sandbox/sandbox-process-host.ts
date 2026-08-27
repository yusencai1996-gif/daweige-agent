import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * 沙箱执行器宿主(0.4.0 C3)——src/main 里**唯一**允许 import node:child_process 的模块
 * (redline-scan 规则守卫)。它只做一件事:启动经过哈希校验的 daweige-sandbox-helper.exe,
 * 并以 4 字节小端长度+JSON 的帧协议与之通信。用户命令永远是 helper 内部的受限进程,
 * Node 不直接 spawn 任何用户命令。
 *
 * 开发态(exe 未构建/缺失)与 E2E:注入 fake 帧传输即可(见 SandboxExecutor),
 * 绝不回退到"裸 Node 跑命令"。
 */

const PROTOCOL_VERSION = 1
const FRAME_MAX_BYTES = 4 * 1024 * 1024
/** capability SID 的内部传递键(helper 从 env 摘出,不传给子进程)。 */
export const CAP_SID_ENV_KEY = 'DWG_CAP_SID'

export interface HostSpawnRequest {
  readonly id: number
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly writableRoots: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export type HelperFrame =
  | { readonly type: 'ready'; readonly version: number }
  | { readonly type: 'spawn_started'; readonly id: number }
  | {
      readonly type: 'output'
      readonly id: number
      readonly stream: 'stdout' | 'stderr'
      readonly sequence: number
      readonly data_b64: string
    }
  | {
      readonly type: 'spawn_exited'
      readonly id: number
      readonly exit_code: number | null
      readonly timed_out: boolean
      readonly cancelled: boolean
      readonly duration_ms: number
    }
  | { readonly type: 'error'; readonly id: number | null; readonly message: string }

/** 帧传输抽象:生产=子进程管道;测试=内存 fake。 */
export interface FrameTransport {
  send(frame: object): void
  /** 注册帧监听;返回解绑函数。 */
  onFrame(listener: (frame: HelperFrame) => void): () => void
  close(): void
}

/** helper exe 定位:打包态在 resources 下 extraResources;开发态在 native 构建产物。 */
async function resolveHelperPath(): Promise<string | undefined> {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'daweige-sandbox-helper.exe'))
  } else {
    candidates.push(
      join(dirname(dirname(dirname(import.meta.dirname ?? ''))), 'native', 'daweige-sandbox-helper', 'target', 'release', 'daweige-sandbox-helper.exe'),
    )
  }
  for (const p of candidates) {
    if (!p) continue
    try {
      const info = await stat(p)
      if (info.isFile()) return p
    } catch {
      // 继续找
    }
  }
  return undefined
}

/** 读取(或创建)helper SHA-256 manifest:开发态构建后生成;打包态随资源分发。 */
async function readExpectedHash(helperPath: string): Promise<string | undefined> {
  const manifestPath = `${helperPath}.sha256`
  try {
    const text = (await readFile(manifestPath, 'utf-8')).trim()
    return text.split(/\s+/)[0] ?? undefined
  } catch {
    return undefined
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * 启动真 helper 的帧传输。任何一步失败(readiness/hash/协议)都抛 SandboxUnavailableError
 * ——调用方据此 fail-closed 拒绝运行命令,不存在裸跑分支。
 */
export async function launchHelperTransport(log: (msg: string) => void): Promise<FrameTransport> {
  const helperPath = await resolveHelperPath()
  if (!helperPath) {
    throw new SandboxUnavailableError('沙箱执行器未安装(缺少 daweige-sandbox-helper.exe);这条命令不会运行')
  }
  const expected = await readExpectedHash(helperPath)
  if (expected) {
    const actual = await sha256OfFile(helperPath)
    if (actual !== expected) {
      throw new SandboxUnavailableError('沙箱执行器校验没通过(文件可能被篡改);这条命令不会运行')
    }
  } else if (app.isPackaged) {
    // 打包态必须有 manifest(构建流程生成);缺失即拒绝,不给"顺手放行"
    throw new SandboxUnavailableError('沙箱执行器完整性信息缺失;这条命令不会运行')
  } else {
    log('沙箱执行器无哈希清单(开发态),跳过校验')
  }

  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const listeners = new Set<(frame: HelperFrame) => void>()
  let buffer = Buffer.alloc(0)
  let ready: ((v: HelperFrame) => void) | undefined
  let closed = false

  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0)
      if (len > FRAME_MAX_BYTES) {
        log('沙箱执行器帧超长,终止会话')
        child.kill()
        return
      }
      if (buffer.length < 4 + len) break
      try {
        const frame = JSON.parse(buffer.subarray(4, 4 + len).toString('utf8')) as HelperFrame
        for (const l of listeners) l(frame)
        if (frame.type === 'ready' && ready) {
          ready(frame)
          ready = undefined
        }
      } catch {
        log('沙箱执行器帧解析失败,忽略一帧')
      }
      buffer = buffer.subarray(4 + len)
    }
  })
  child.stderr.on('data', (d: Buffer) => log(`[sandbox-helper] ${d.toString('utf8').trim()}`))
  child.on('exit', () => {
    closed = true
  })

  const waitReady = new Promise<HelperFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SandboxUnavailableError('沙箱执行器没有在时限内就绪')), 5_000)
    ready = (f) => {
      clearTimeout(timer)
      resolve(f)
    }
  })
  const readyFrame = await waitReady
  if (readyFrame.type !== 'ready' || readyFrame.version !== PROTOCOL_VERSION) {
    child.kill()
    throw new SandboxUnavailableError('沙箱执行器协议版本不匹配;这条命令不会运行')
  }

  return {
    send(frame: object): void {
      if (closed) throw new SandboxUnavailableError('沙箱执行器已退出;这条命令不会运行')
      const payload = Buffer.from(JSON.stringify(frame), 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(payload.length)
      child.stdin.write(Buffer.concat([len, payload]))
    },
    onFrame(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close(): void {
      try {
        child.stdin.end()
      } catch {
        // 已退出
      }
      child.kill()
    },
  }
}

/** 新命令 id(自增,帧内标识)。 */
export function nextCommandId(): number {
  return commandIdCounter++
}

let commandIdCounter = Math.floor(Math.random() * 1000) + 1

export function newCorrelationId(): string {
  return randomUUID()
}
