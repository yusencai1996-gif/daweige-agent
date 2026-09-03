import { useCallback, useEffect, useRef, useState } from 'react'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type {
  MemoryDate,
  MemoryListPage,
  MemoryMergeState,
  MemoryNoteSummary,
} from '../../../shared/domain'
import { MemoryClearDialog } from './MemoryClearDialog'
import {
  applyMemoryClear,
  applyMemoryDelete,
  fetchFirstMemoryPage,
  fetchNextMemoryPage,
} from './memory-paging'

interface MemoryPanelProps {
  readonly bridge: DaweigeBridge
}

/** 日期人话:recurring=每年 M 月 D 日;fixed=具体日期。 */
function dateText(date: MemoryDate | undefined): string | null {
  if (!date) return null
  if (date.kind === 'recurring') return `每年${date.month}月${date.day}日`
  const [year, month, day] = date.iso.split('-').map(Number)
  if (!year || !month || !day) return date.iso
  return `${year}年${month}月${day}日`
}

/** 创建时间人话:YYYY-MM-DD HH:mm(本地时区)。 */
function createdText(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 来源人话:角色名 / 旧生活记事。 */
function sourceText(entry: MemoryNoteSummary): string {
  return entry.source.kind === 'conversation' ? entry.source.roleDisplayName : '旧生活记事'
}

/** mergeState 轻量状态文案;clean 不出声,不阻塞查看和删除。 */
function mergeStateText(state: MemoryMergeState): string | null {
  switch (state) {
    case 'pending':
      return '有新的记忆变化待整理;可以先正常查看、删除。'
    case 'running':
      return '正在整理记忆…可以先正常查看、删除。'
    case 'failed':
      return '整理失败,可继续查看和删除;之后对话时会自动重试。'
    default:
      return null
  }
}

interface MemoryRowProps {
  readonly entry: MemoryNoteSummary
  readonly onDelete: (memoryId: string) => void
}

/** 单条记忆;删除行内二次确认:3 秒内再点才真删,超时或移开恢复。 */
function MemoryRow({ entry, onDelete }: MemoryRowProps) {
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<number | null>(null)

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setConfirming(false)
  }, [])

  useEffect(() => reset, [reset]) // 卸载时清定时器

  const handleClick = () => {
    if (!confirming) {
      setConfirming(true)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setConfirming(false)
      }, 3000)
      return
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setConfirming(false)
    onDelete(entry.id)
  }

  const when = dateText(entry.date)

  return (
    <div className="memory-item">
      <div className="memory-item-main">
        <div className="memory-item-head">
          {entry.title !== undefined && entry.title !== '' && (
            <span className="memory-item-title">{entry.title}</span>
          )}
          <span className="memory-item-source">{sourceText(entry)}</span>
          {entry.category !== undefined && entry.category !== '' && (
            <span className="memory-item-category">{entry.category}</span>
          )}
          {when && <span className="memory-item-date">{when}</span>}
        </div>
        <div className="memory-item-text">{entry.content}</div>
        <div className="memory-item-time">{createdText(entry.createdAt)} 记下</div>
      </div>
      <button
        type="button"
        className={confirming ? 'btn btn-ghost btn-sm memory-delete-confirm' : 'btn btn-ghost btn-sm'}
        onClick={handleClick}
        onMouseLeave={reset}
      >
        {confirming ? '确认删除?' : '删除'}
      </button>
    </div>
  )
}

/**
 * 设置页「记忆管理」:数据源为 memory:list 的首个 MemoryListPage(含 mergeState)。
 * 单条删除保留行内二次确认;「一键清空」必须过确认卡(MemoryClearDialog);
 * 面板打开期间监听 memory_changed,防抖重拉。
 */
export function MemoryPanel({ bridge }: MemoryPanelProps) {
  const [snapshot, setSnapshot] = useState<MemoryListPage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  /** 「加载更多」在途标记:防重复点击,翻页期间按钮禁用。 */
  const [loadingMore, setLoadingMore] = useState(false)
  /** 「一键清空」触发按钮:弹层关闭后焦点归还到这里。 */
  const clearTriggerRef = useRef<HTMLButtonElement>(null)
  /** memory_changed 防抖计时器:500ms 窗口合并成一次重拉。 */
  const syncTimerRef = useRef<number | null>(null)

  /** silent=true(memory_changed 后台重拉)不清用户正在看的提示。永远拉第一页。 */
  const load = useCallback(
    async (options?: { readonly silent?: boolean }) => {
      if (!options?.silent) {
        setLoadError(null)
        setNotice(null)
      }
      try {
        const result = await fetchFirstMemoryPage(bridge)
        setSnapshot(result)
        setLoadError(null)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    },
    [bridge],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 面板打开期间:别的会话增删了记忆 / 合并完成 / 迁移完成 → 防抖重拉
  useEffect(() => {
    const unsubscribe = bridge.onAgentEvent((event) => {
      if (event.type !== 'memory_changed') return
      if (syncTimerRef.current !== null) return
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null
        void load({ silent: true })
      }, 500)
    })
    return () => {
      unsubscribe()
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current)
        syncTimerRef.current = null
      }
    }
  }, [bridge, load])

  /**
   * 加载更多(E-4):用 nextCursor 拉下一页追加;响应 reset=true(revision 变了)
   * 时丢弃已加载列表、整页替换成新第一页,绝不拼接新旧快照。
   */
  const loadMore = async () => {
    if (loadingMore) return
    const current = snapshot
    if (current === null || current.nextCursor === undefined) return
    setLoadingMore(true)
    setNotice(null)
    try {
      const merged = await fetchNextMemoryPage(bridge, current)
      setSnapshot(merged)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingMore(false)
    }
  }

  const remove = async (memoryId: string) => {
    setNotice(null)
    try {
      const result = await bridge.invoke('memory:delete', { memoryId })
      if (result.deleted) {
        // 删除成功立即从列表移除;mergeState 用响应值即时更新,不等下次 memory:list
        setSnapshot((prev) => (prev === null ? prev : applyMemoryDelete(prev, memoryId, result)))
      } else {
        // 先刷新列表再提示,避免 load() 清掉刚设的提示
        void load().then(() => setNotice('这条已经不存在了'))
      }
    } catch (error) {
      // 失败保持原状态(mergeState/列表都不动)
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const clearAll = async (): Promise<{ readonly ok: boolean; readonly message?: string }> => {
    try {
      const result = await bridge.invoke('memory:clear', undefined)
      // 清空成功:列表归零,mergeState 用响应值即时更新;失败保持原状态
      setSnapshot((prev) => (prev === null ? prev : applyMemoryClear(prev, result)))
      setClearDialogOpen(false)
      setNotice(`已清空 ${result.deletedCount} 条记忆。`)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const entries = snapshot?.entries ?? null
  const mergeHint = snapshot === null ? null : mergeStateText(snapshot.mergeState)

  return (
    <div className="memory-panel">
      <div className="memory-toolbar">
        <span className="memory-toolbar-desc">它记住的东西都在你自己电脑里,不会外传。</span>
        <div className="memory-toolbar-actions">
          {entries !== null && entries.length > 0 && (
            <button
              type="button"
              ref={clearTriggerRef}
              className="btn btn-ghost btn-sm danger"
              onClick={() => setClearDialogOpen(true)}
            >
              一键清空
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      {mergeHint !== null && (
        <div className="memory-merge-state" role="status">
          {mergeHint}
        </div>
      )}

      {loadError ? (
        <div className="memory-state" role="alert">
          没拉出来:{loadError}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            再试一次
          </button>
        </div>
      ) : entries === null ? (
        <div className="memory-state">正在翻记事本…</div>
      ) : entries.length === 0 ? (
        <div className="memory-state">
          还没让它记住过什么。对它说「记住 XX」就会出现在这里。
        </div>
      ) : (
        <>
          <div className="memory-list">
            {entries.map((entry) => (
              <MemoryRow key={entry.id} entry={entry} onDelete={(id) => void remove(id)} />
            ))}
          </div>
          {snapshot !== null && snapshot.nextCursor !== undefined && (
            <div className="memory-more">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore
                  ? '正在翻页…'
                  : `加载更多(已显示 ${entries.length}/共 ${snapshot.total})`}
              </button>
            </div>
          )}
        </>
      )}

      {notice && (
        <div className="memory-notice" role="status">
          {notice}
        </div>
      )}

      {clearDialogOpen && snapshot !== null && (
        <MemoryClearDialog
          count={snapshot.total}
          onConfirm={clearAll}
          onCancel={() => setClearDialogOpen(false)}
        />
      )}
    </div>
  )
}
