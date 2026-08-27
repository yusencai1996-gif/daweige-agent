/**
 * 命令实时输出(renderer 本地视图态,不进 shared 契约;0.4.0 C)。
 * controller 与 CommandBlock 共用,单独成模块避免两者循环引用。
 */
export interface CommandLiveChunks {
  /** 归属会话(agent_end/会话清理时按它精准回收,child=internal 会话)。 */
  readonly sessionId: string
  readonly stdout: ReadonlyMap<number, string>
  readonly stderr: ReadonlyMap<number, string>
  /** 各流独立的滚动截断标志(超 256 KiB 丢最旧段时置位)。 */
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/** live chunks 按 sequence 排序拼接(乱序/重复到达安全)。 */
export function joinChunks(chunks: ReadonlyMap<number, string>): string {
  return [...chunks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('')
}
