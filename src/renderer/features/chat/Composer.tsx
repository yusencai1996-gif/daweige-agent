import { useEffect, useRef, useState } from 'react'
import type { ProviderInfo, ProviderSelection, ThinkingLevel } from '../../../shared/domain'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { ContextUsageState } from '../../app/use-app-controller'
import { ProviderSelector } from './ProviderSelector'

interface ComposerProps {
  readonly bridge: DaweigeBridge
  /** 激活会话 id;无会话时上传文件按钮禁用。 */
  readonly sessionId: string | null
  /** 当前会话的未发送草稿(按会话隔离,A-12);受控值,由 controller 分槽保存。 */
  readonly draft: string
  readonly onDraftChange: (text: string) => void
  readonly disabled: boolean
  /** 当前会话已归档:只读回看,占位文案换成归档提示。 */
  readonly archived: boolean
  readonly streaming: boolean
  readonly sending: boolean
  readonly contextUsage: ContextUsageState | null
  readonly providers: readonly ProviderInfo[]
  readonly selection: ProviderSelection
  /** 启用池(settings.enabledModels);undefined/空=老数据,模型面板回退只显示当前一项。 */
  readonly enabledModels?: readonly ProviderSelection[] | undefined
  readonly supportsThinking: boolean
  readonly thinkingLevel: ThinkingLevel
  readonly onToggleSidebar: () => void
  readonly onSelectProvider: (selection: ProviderSelection) => void
  readonly onChangeThinking: (level: ThinkingLevel) => void
  readonly onSend: (text: string) => void
  readonly onAbort: () => void
}

/** 千位缩写:12300 → "12.3k",256000 → "256k"。 */
function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = Math.round(n / 100) / 10
    return `${k}k`
  }
  return String(n)
}

/** 上下文用量环:轨道 --line,进度 --accent;无数据时只显示空轨道。 */
function ContextRing({ usage }: { readonly usage: ContextUsageState | null }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const ratio = usage ? Math.min(1, Math.max(0, usage.usedTokens / usage.contextWindow)) : 0
  const tooltip = usage
    ? `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindow)}`
    : '还没有上下文用量数据'
  return (
    <span className="context-ring" title={tooltip} aria-label={`上下文用量:${tooltip}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-ring-track" cx="8" cy="8" r={radius} fill="none" />
        {usage && (
          <circle
            className="context-ring-progress"
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
    </span>
  )
}

/** 底部输入框:Enter 发送,Shift+Enter 换行;下方工具行承载导入/权限/用量/模型/思考/发送停止。 */
export function Composer({
  bridge,
  sessionId,
  draft,
  onDraftChange,
  disabled,
  archived,
  streaming,
  sending,
  contextUsage,
  providers,
  selection,
  enabledModels,
  supportsThinking,
  thinkingLevel,
  onToggleSidebar,
  onSelectProvider,
  onChangeThinking,
  onSend,
  onAbort,
}: ComposerProps) {
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const importTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (importTimerRef.current !== null) window.clearTimeout(importTimerRef.current)
    },
    [],
  )

  // 导入提示是瞬时条,随会话切换清掉(连同未响的定时器),不跨会话残留(A-12)。
  useEffect(() => {
    setImportNotice(null)
    if (importTimerRef.current !== null) {
      window.clearTimeout(importTimerRef.current)
      importTimerRef.current = null
    }
  }, [sessionId])

  const submit = () => {
    const text = draft.trim()
    if (text === '' || disabled || streaming || sending) return
    onSend(text)
    onDraftChange('') // 发出即清当前会话草稿槽(沿用原清空时机)
  }

  const importFiles = async () => {
    if (!sessionId) return
    try {
      const files = await bridge.invoke('workspace:importFiles', { sessionId })
      if (files.length === 0) return // 用户取消,不提示
      setImportNotice(`已导入 ${files.length} 个文件到工作文件夹`)
      if (importTimerRef.current !== null) window.clearTimeout(importTimerRef.current)
      importTimerRef.current = window.setTimeout(() => setImportNotice(null), 3200)
    } catch {
      // 会话不存在等异常:静默,不打扰输入
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          value={draft}
          rows={2}
          disabled={disabled}
          placeholder={
            archived
              ? '这条会话已归档,去「归档」恢复后继续聊'
              : disabled
                ? '先在左侧选一个会话,或新建一个'
                : '告诉它要干什么,比如:把下载文件夹里的图片按月份归档'
          }
          aria-label="输入要它干的活"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              type="button"
              className="menu-btn"
              onClick={onToggleSidebar}
              aria-label="打开会话列表"
            >
              ☰ 会话
            </button>
            <button
              type="button"
              className="composer-tool-btn"
              title="上传文件到工作文件夹"
              aria-label="上传文件到工作文件夹"
              disabled={!sessionId}
              onClick={() => void importFiles()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21 12.5l-8.6 8.6a5.6 5.6 0 0 1-7.9-7.9l9.2-9.2a3.7 3.7 0 0 1 5.3 5.3l-9.2 9.2a1.9 1.9 0 0 1-2.7-2.7l8.5-8.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <span
              className="composer-perm"
              title="读文件直接执行;改动会先弹卡片问你"
              aria-label="权限说明:读文件直接执行,改动会先弹卡片问你"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 3l7 3v5.2c0 4.4-2.9 7.7-7 9.8-4.1-2.1-7-5.4-7-9.8V6l7-3z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.2 12.1l1.9 1.9 3.7-3.9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            {importNotice && <span className="composer-import-notice">{importNotice}</span>}
          </div>
          <div className="composer-controls">
            <ContextRing usage={contextUsage} />
            <ProviderSelector
              providers={providers}
              selection={selection}
              enabledModels={enabledModels}
              onSelect={onSelectProvider}
            />
            {supportsThinking && (
              <select
                className="thinking-select"
                value={thinkingLevel}
                title="思考强度"
                aria-label="思考强度"
                onChange={(e) => onChangeThinking(e.target.value as ThinkingLevel)}
              >
                <option value="off">思考 关</option>
                <option value="low">思考 低</option>
                <option value="high">思考 高</option>
              </select>
            )}
            {streaming ? (
              <button
                type="button"
                className="composer-stop-btn"
                title="停止"
                aria-label="停止"
                onClick={onAbort}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect
                    x="2"
                    y="2"
                    width="8"
                    height="8"
                    rx="1.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={submit}
                disabled={disabled || sending || draft.trim() === ''}
              >
                {sending ? '发送中…' : '发送'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
