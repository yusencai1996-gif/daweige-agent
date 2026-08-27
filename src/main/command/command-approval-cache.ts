import type { ApprovalDecision } from '../../shared/domain/approval'

/**
 * 命令审批缓存(0.4.0 C3)——与文件工具的 sessionId→toolName 会话授权**完全独立**
 * (PLAN §5.3 红线:旧通道按工具名放行,对 run_command 会变成"批准一条=放行所有命令"的大洞)。
 *
 * 键=完全相同的执行上下文(ownerSessionId+规范命令+real cwd+timeout+沙箱档+写根+run/revision)。
 * - turn 粘性:同一次模型回合内重复出现完全相同命令不再弹卡;
 * - session 档:同 owner 会话内完全相同命令免卡(仅内存,重启/会话删/迁移/run 终态/写根变化立即清);
 * - forbidden 永远优先于缓存;policy allow 不写缓存;
 * - command A 的授权绝不流向 child;child A 不流向 child B;surface 不等于 owner。
 */

export interface CommandCacheKeyInput {
  readonly ownerSessionId: string
  /** 已归一的精确命令(执行原文,不经任何改写)。 */
  readonly command: string
  readonly realCwd: string
  readonly timeoutMs: number
  readonly sandboxLevel: string
  /** 排序后的 realpath 快照。 */
  readonly writableRoots: readonly string[]
  /** delegated run 的 runId;manager 工作区迁移代数;普通会话为空。 */
  readonly scopeId: string
}

function buildKey(input: CommandCacheKeyInput): string {
  const roots = [...input.writableRoots].sort().join('|')
  return [input.ownerSessionId, input.command, input.realCwd, String(input.timeoutMs), input.sandboxLevel, roots, input.scopeId].join('\u0000')
}

interface CacheEntry {
  /** 本条缓存的失效代数(与 key 的 scopeId 一致,便于对照清理)。 */
  readonly scopeId: string
}

export class CommandApprovalCache {
  /** turn 级(approvalScopeId → Set<key>)。 */
  private readonly turnGrants = new Map<string, Set<string>>()
  /** session 级(ownerSessionId → Map<key, entry>)。 */
  private readonly sessionGrants = new Map<string, Map<string, CacheEntry>>()

  /** 新模型回合开始:生成/切换 turn 作用域(旧 turn 的粘性授权随之作废)。 */
  beginTurn(approvalScopeId: string): void {
    // 保留其他在途 turn 的槽(并行 child 各自一槽);只确保新槽存在
    if (!this.turnGrants.has(approvalScopeId)) {
      this.turnGrants.set(approvalScopeId, new Set())
    }
  }

  /** 回合结束/中止:清该 turn 的粘性授权。 */
  endTurn(approvalScopeId: string): void {
    this.turnGrants.delete(approvalScopeId)
  }

  /** 同 turn 内是否已放行过完全相同的命令上下文。 */
  hasTurnGrant(approvalScopeId: string, input: CommandCacheKeyInput): boolean {
    return this.turnGrants.get(approvalScopeId)?.has(buildKey(input)) ?? false
  }

  /** 同 owner 会话内是否已"本次会话允许"过完全相同的命令上下文。 */
  hasSessionGrant(input: CommandCacheKeyInput): boolean {
    return this.sessionGrants.get(input.ownerSessionId)?.has(buildKey(input)) ?? false
  }

  /** 记录一次放行。approve=turn 粘性;approve-session=turn+session 双登记。 */
  recordDecision(
    approvalScopeId: string | undefined,
    input: CommandCacheKeyInput,
    decision: ApprovalDecision,
  ): void {
    if (decision === 'reject') return
    const key = buildKey(input)
    if (approvalScopeId !== undefined) {
      let set = this.turnGrants.get(approvalScopeId)
      if (!set) {
        set = new Set()
        this.turnGrants.set(approvalScopeId, set)
      }
      set.add(key)
    }
    if (decision === 'approve-session') {
      let map = this.sessionGrants.get(input.ownerSessionId)
      if (!map) {
        map = new Map()
        this.sessionGrants.set(input.ownerSessionId, map)
      }
      map.set(key, { scopeId: input.scopeId })
    }
  }

  /** 会话删除/结束时整体清空该 owner 的 session 档(委托链子会话各自独立)。 */
  clearSession(ownerSessionId: string): void {
    this.sessionGrants.delete(ownerSessionId)
  }

  /** scope 失效(run 终态/写根变化/工作区迁移代数变化):清所有匹配的 session 档条目。 */
  invalidateScope(scopeId: string): void {
    for (const [sessionId, map] of this.sessionGrants) {
      for (const [key, entry] of map) {
        if (entry.scopeId === scopeId) map.delete(key)
      }
      if (map.size === 0) this.sessionGrants.delete(sessionId)
    }
  }

  /** 全部清空(测试/降级用)。 */
  clearAll(): void {
    this.turnGrants.clear()
    this.sessionGrants.clear()
  }
}
