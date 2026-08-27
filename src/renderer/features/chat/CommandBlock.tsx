import { useState } from 'react'
import type { ToolExecutionInfo } from '../../../shared/domain'
import type { CommandResultDetails } from '../../../shared/domain/command'
import { joinChunks, type CommandLiveChunks } from './command-live'

interface CommandBlockProps {
  readonly execution: ToolExecutionInfo
  /** 运行中实时输出(controller 维护);终值 command 到达后 live 已清除,渲染走 details。 */
  readonly live?: CommandLiveChunks
}

function durationText(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/**
 * 命令工具过程块(C4):头部=状态徽标+命令一行(等宽,横向滚动,一字不改写)+耗时;
 * body 默认折叠,展开看 stdout/stderr(分栏;数据无时间戳,不伪合并时间序)、
 * 退出码与截断标记。两态数据源:终值 ToolExecutionInfo.command(实时 command_finished
 * 合成 / 刷新后 mapper 从 pi toolResult.details 重建);运行中 command_output live 流。
 */
export function CommandBlock({ execution, live }: CommandBlockProps) {
  const details = execution.command
  const [open, setOpen] = useState(false)
  if (details === undefined && live === undefined) {
    // 无终值也无实时流(理论不到:分流处已保证;兜底回退普通工具行语义由父层处理)
    return null
  }

  // 运行中:头部命令行用 summary(tool_start 携带),流式展开实时输出
  const commandLine = details?.command ?? execution.summary ?? '命令运行中…'
  const badge = commandBadge(execution, details)
  const running =
    details === undefined && (execution.status === 'running' || execution.status === 'pending')
  const stdoutText = details ? details.stdout : live ? joinChunks(live.stdout) : ''
  const stderrText = details ? details.stderr : live ? joinChunks(live.stderr) : ''

  return (
    <div className="command-block" role="status">
      <div className="command-head">
        <span className={badge.className} aria-hidden="true" />
        <code className="command-line" title={commandLine}>
          {commandLine}
        </code>
        <span className="command-state">{running ? '运行中' : badge.text}</span>
        {!running && details !== undefined && (
          <span className="command-duration">{durationText(details.durationMs)}</span>
        )}
        <button
          type="button"
          className="command-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          过程输出 {open ? '▾' : '▸'}
        </button>
      </div>

      {open && (
        <div className="command-body">
          <pre className="command-output" tabIndex={0}>
            <code>{stdoutText === '' && running ? '(还没有输出…)' : stdoutText === '' ? '(没有输出)' : stdoutText}</code>
          </pre>
          {stderrText !== '' && (
            <>
              <div className="command-output-label command-output-label-err">错误输出</div>
              <pre className="command-output command-output-err" tabIndex={0}>
                <code>{stderrText}</code>
              </pre>
            </>
          )}
          {details !== undefined && details.stdoutTruncated && (
            <div className="command-truncated">标准输出过长,这里只保留了能放下的一段。</div>
          )}
          {details !== undefined && details.stderrTruncated && (
            <div className="command-truncated">错误输出过长,这里只保留了能放下的一段。</div>
          )}
          {running && (live?.stdoutTruncated ?? false) && (
            <div className="command-truncated">输出很长,只保留了最近一段。</div>
          )}
          {running && (live?.stderrTruncated ?? false) && (
            <div className="command-truncated">错误输出很长,只保留了最近一段。</div>
          )}
          {details !== undefined && (
            <div className={details.exitCode === 0 ? 'command-exit' : 'command-exit nonzero'}>
              退出码 {details.exitCode === null ? '未知' : details.exitCode}
              {details.cwd !== '' && <span className="command-exit-cwd"> · 在 {details.cwd} 运行</span>}
            </div>
          )}
          {running && (
            <div className="command-exit">命令还在沙箱里跑着,输出边跑边来…</div>
          )}
          {details === undefined && !running && (
            <div className="command-exit">这一轮没有等到命令的最终回执(可能被中途停止),以上是停止前的输出。</div>
          )}
        </div>
      )}
    </div>
  )
}

function commandBadge(
  execution: ToolExecutionInfo,
  details: CommandResultDetails | undefined,
): { className: string; text: string } {
  // 终态优先:abort/中断路径 onFinished 缺席(details 永不到)时按工具行状态收尾,不永远转圈
  if (execution.status === 'failed') {
    return { className: 'command-badge command-badge-fail', text: '失败' }
  }
  if (execution.status === 'rejected') {
    return { className: 'command-badge command-badge-muted', text: '已拒绝' }
  }
  if (execution.status === 'succeeded' && details === undefined) {
    return { className: 'command-badge command-badge-ok', text: '完成' }
  }
  if (details === undefined) {
    return { className: 'command-badge command-badge-spin', text: '运行中' }
  }
  if (details.cancelled) return { className: 'command-badge command-badge-muted', text: '已取消' }
  if (details.timedOut) return { className: 'command-badge command-badge-fail', text: '超时' }
  if (details.exitCode !== null && details.exitCode !== 0) {
    return { className: 'command-badge command-badge-fail', text: `退出 ${details.exitCode}` }
  }
  return { className: 'command-badge command-badge-ok', text: '完成' }
}
