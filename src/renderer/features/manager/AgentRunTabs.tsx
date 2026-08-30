import type { AgentRunSummary } from '../../../shared/domain'
import { shortStatusText, statusInfo } from './DelegationCard'

/**
 * 角色 tab 条(A-28,PLAN §6.3):详情态右栏顶部,一个角色一个 tab(浏览器 tab 式),
 * 切换查看各角色的完整输出。节点顺序=拓扑序(由 VerticalRunFlow 同源 layout 算好传入)。
 *
 * 每个 tab:状态点 + 角色名 + 状态短语;选中 tab 朱砂下划一笔(克制,不整tab上色)。
 * 纯受控组件:选中态/切换回调都由 Host 给。
 */

interface AgentRunTabsProps {
  readonly nodes: readonly AgentRunSummary[]
  readonly selectedRunId: string | null
  readonly onSelect: (runId: string) => void
}

export function AgentRunTabs({ nodes, selectedRunId, onSelect }: AgentRunTabsProps) {
  return (
    <div className="collab-tabs" role="tablist" aria-label="各角色干活过程">
      {nodes.map((node) => {
        const info = statusInfo(node)
        const selected = node.runId === selectedRunId
        return (
          <button
            key={node.runId}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`collab-tab${selected ? ' is-active' : ''}`}
            title={`${node.targetRoleName}:${shortStatusText(node)}`}
            onClick={() => onSelect(node.runId)}
          >
            <span className={`delegation-dot ${info.tone}`} aria-hidden="true" />
            <span className="collab-tab-name">{node.targetRoleName}</span>
            <span className="collab-tab-state muted">{shortStatusText(node)}</span>
          </button>
        )
      })}
    </div>
  )
}
