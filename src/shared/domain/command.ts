/**
 * 命令执行域模型(0.4.0 C:沙箱+跑命令)。
 * 铁律:
 * - command 原文展示/执行,主进程不做语法改写;策略归一只在主进程;
 * - SandboxProfileSnapshot 如实快照实际权限,UI 按它展示(网络未隔离=诚实标注);
 * - 绝不出现 Disabled/"批准后裸跑"档。
 */

/** 审批引擎三级决策(allow=免卡仍过沙箱;prompt=弹卡;forbidden=直接拒)。 */
export type ExecPolicyDecision = 'allow' | 'prompt' | 'forbidden'

/** 命令输出流(实时推送与工具结果共用)。 */
export type CommandOutputStream = 'stdout' | 'stderr'

/** run_command 工具入参(模型侧;主进程仍逐项校验)。 */
export interface RunCommandInput {
  /** trim 后 1..16384 字;原样显示/执行。 */
  readonly command: string
  /** 工作目录;缺省=会话有效工作区;提供时必须落在写根内(realpath 校验)。 */
  readonly cwd?: string
  /** 1_000..300_000,缺省 120_000。 */
  readonly timeoutMs?: number
}

/** 沙箱档位快照(一期固定 restricted-token;读全盘/写仅授权根;网络未隔离)。 */
export interface SandboxProfileSnapshot {
  readonly level: 'restricted-token'
  readonly readable: 'all-local-files'
  /** 1..8 个 realpath 快照。 */
  readonly writableRoots: readonly string[]
  /** 0.4.0 诚实标注:本版未隔离网络,不放名不副实的断网开关。 */
  readonly network: 'not-isolated'
}

/** 命令确认卡(0.4.0 C);响应走既有 approval:respond 通道。 */
export interface CommandApprovalRequest {
  readonly id: string
  readonly kind: 'command'
  /** 人话标题,如"我要运行一条命令"。 */
  readonly title: string
  /** 人话说明(策略理由+影响摘要)。 */
  readonly description: string
  /** 命令原文(等宽展示,可复制,不改写)。 */
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly sandbox: SandboxProfileSnapshot
  /** policy 人话理由(forbidden 不到卡;prompt=为什么需要确认)。 */
  readonly reason: string
  readonly toolCallId: string
  readonly toolName: 'run_command'
  readonly createdAt: number
}

/** 命令执行结果(完整版落 pi 会话;push 只发实时增量)。 */
export interface CommandResultDetails {
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}
