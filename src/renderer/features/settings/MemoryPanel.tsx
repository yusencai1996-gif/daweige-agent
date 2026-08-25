import { useCallback, useEffect, useRef, useState } from 'react'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { MemoryEntry } from '../../../shared/domain'

interface MemoryPanelProps {
  readonly bridge: DaweigeBridge
}

/** 日期人话:recurring=每年 M 月 D 日;fixed=具体日期。 */
function dateText(date: MemoryEntry['date']): string | null {
  if (!date) return null
  if (date.kind === 'recurring') return `每年${date.month}月${date.day}日`
  const [year, month, day] = date.iso.split('-').map(Number)
  if (!year || !month || !day) return date.iso
  return `${year}年${month}月${day}日`
}

interface MemoryRowProps {
  readonly entry: MemoryEntry
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
          <span className="memory-item-title">{entry.title}</span>
          <span className="memory-item-category">{entry.category}</span>
          {when && <span className="memory-item-date">{when}</span>}
        </div>
        <div className="memory-item-text">{entry.text}</div>
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
 * 设置页「记忆管理」:列出用户让 AI 记住的所有内容,可逐条删除。
 * 进入时自动拉全量;不做实时同步,顶部「刷新」手动重拉。
 */
export function MemoryPanel({ bridge }: MemoryPanelProps) {
  const [memories, setMemories] = useState<readonly MemoryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    setNotice(null)
    try {
      const list = await bridge.invoke('memory:list', undefined)
      setMemories(list)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [bridge])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (memoryId: string) => {
    setNotice(null)
    try {
      const { deleted } = await bridge.invoke('memory:delete', { memoryId })
      if (deleted) {
        setMemories((prev) => prev?.filter((m) => m.id !== memoryId) ?? prev)
      } else {
        // 先刷新列表再提示,避免 load() 清掉刚设的提示
        void load().then(() => setNotice('这条已经不存在了'))
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="memory-panel">
      <div className="memory-toolbar">
        <span className="memory-toolbar-desc">它记住的东西都在你自己电脑里,不会外传。</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {loadError ? (
        <div className="memory-state" role="alert">
          没拉出来:{loadError}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            再试一次
          </button>
        </div>
      ) : memories === null ? (
        <div className="memory-state">正在翻记事本…</div>
      ) : memories.length === 0 ? (
        <div className="memory-state">
          还没让它记住过什么。对它说「记住 XX」就会出现在这里。
        </div>
      ) : (
        <div className="memory-list">
          {memories.map((entry) => (
            <MemoryRow key={entry.id} entry={entry} onDelete={(id) => void remove(id)} />
          ))}
        </div>
      )}

      {notice && (
        <div className="memory-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
