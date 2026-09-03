import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { MemoryListPage, MemoryMergeState } from '../../../shared/domain'

/**
 * 记忆分页状态逻辑(0.7.0 E-4)——纯函数,不依赖 React/DOM,单测用 MockBridge 驱动。
 * MemoryPanel 只负责渲染和事件接线,状态合并规则全部收敛在这里。
 */

/** 首屏与每页条数(契约 limit 1..100,默认 50)。 */
export const MEMORY_PAGE_SIZE = 50

/**
 * 把新一页并入已加载快照。
 * - page.reset=true(revision 变了,游标失效):整页替换,绝不把新旧快照拼在一起;
 * - 否则追加到已加载条目之后,revision/mergeState/total/nextCursor 以新页为准。
 */
export function applyMemoryPage(prev: MemoryListPage | null, page: MemoryListPage): MemoryListPage {
  if (prev === null || page.reset) return page
  return { ...page, entries: [...prev.entries, ...page.entries] }
}

/** 拉第一页(首屏 / 刷新 / memory_changed 回第一页,同一入口)。 */
export async function fetchFirstMemoryPage(bridge: DaweigeBridge): Promise<MemoryListPage> {
  return bridge.invoke('memory:list', { limit: MEMORY_PAGE_SIZE })
}

/**
 * 用当前快照的 nextCursor 拉下一页并合并。
 * current 没有 nextCursor 时原样返回(防御:按钮本不该出现)。
 */
export async function fetchNextMemoryPage(
  bridge: DaweigeBridge,
  current: MemoryListPage,
): Promise<MemoryListPage> {
  if (current.nextCursor === undefined) return current
  const page = await bridge.invoke('memory:list', {
    cursor: current.nextCursor,
    limit: MEMORY_PAGE_SIZE,
  })
  return applyMemoryPage(current, page)
}

interface MemoryMutationResult {
  readonly revision: number
  readonly mergeState: MemoryMergeState
}

/**
 * 单条删除成功后的本地即时更新(0.7.0 E-7 附带):
 * 条目立刻消失、total-1,revision/mergeState 用响应值,不等下次 memory:list。
 * 注意:删除后 revision 已变,旧 nextCursor 下次翻页会拿到 reset=true 整页替换,属预期。
 */
export function applyMemoryDelete(
  prev: MemoryListPage,
  memoryId: string,
  result: MemoryMutationResult,
): MemoryListPage {
  return {
    ...prev,
    revision: result.revision,
    mergeState: result.mergeState,
    total: Math.max(0, prev.total - 1),
    entries: prev.entries.filter((entry) => entry.id !== memoryId),
  }
}

/** 清空成功后的本地即时更新:列表归零,revision/mergeState 用响应值。 */
export function applyMemoryClear(prev: MemoryListPage, result: MemoryMutationResult): MemoryListPage {
  return {
    ...prev,
    revision: result.revision,
    mergeState: result.mergeState,
    entries: [],
    total: 0,
    nextCursor: undefined,
  }
}
