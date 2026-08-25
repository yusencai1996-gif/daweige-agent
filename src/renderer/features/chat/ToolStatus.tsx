import type { ToolExecutionInfo } from '../../../shared/domain'

/** 工具状态行:进行中用进行时+省略号,辅助信息用弱化色。 */
export function ToolStatus({ execution }: { readonly execution: ToolExecutionInfo }) {
  const text = toolStatusText(execution)
  return (
    <div
      className={execution.status === 'running' ? 'tool-status running' : 'tool-status'}
      role="status"
    >
      <span className="tool-status-dot" aria-hidden="true" />
      <span>{text}</span>
      {execution.status === 'failed' && execution.error && <span>——{execution.error}</span>}
    </div>
  )
}

function toolStatusText(execution: ToolExecutionInfo): string {
  const what = execution.summary ?? execution.displayName
  switch (execution.status) {
    case 'pending':
      return `等你确认:${what}`
    case 'running':
      return `${execution.displayName}中…`
    case 'succeeded':
      return `已完成:${what}`
    case 'rejected':
      return `已拒绝:${what}`
    case 'failed':
      return `没成功:${what}`
  }
}
