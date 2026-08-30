import {
  SqliteSessionRepository,
  createNodeSqliteFactory,
  type SqliteSessionMetadata,
} from '@earendil-works/pi-session-backend-sqlite-node'
import type { CompactionEntry, Session } from '@earendil-works/pi-agent-core'
import { dirname } from 'node:path'
import { promises as fs } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { ProviderId } from '../../shared/domain/provider'
import { createNodeSqliteEnv } from './sqlite-env'

/**
 * 会话仓库适配(M2-05)。
 * 数据库:userData/data/sessions.sqlite(node:sqlite,Electron 43/Node 24 内置)。
 * 我们的 provider/model/updatedAt 存进 pi 的自由 metadata 字段。
 */

/** 存进 pi metadata 的应用字段。 */
export interface DaweigeSessionAppMeta {
  providerId: ProviderId
  modelId: string
  updatedAt: number
  /** pi 库自身的纵深标记；角色 binding 丢失时仍能识别 child 会话。 */
  internal?: true
}

/** 只读遍历的 message entry 行(使用统计回填专用)。 */
export type UsageEntryRow =
  | {
      readonly type: 'message'
      readonly sessionId: string
      readonly entryId: string
      readonly seq: number
      readonly timestamp: number
      readonly message: unknown
    }
  | {
      readonly type: 'compaction'
      readonly sessionId: string
      readonly entryId: string
      readonly seq: number
      readonly timestamp: number
      readonly entry: CompactionEntry
    }

/** @deprecated 改用 UsageEntryRow；保留导出避免外部测试夹具断裂。 */
export interface MessageEntryRow {
  readonly sessionId: string
  readonly entryId: string
  readonly seq: number
  readonly timestamp: number
  /** pi 存储的完整 AgentMessage payload;形态由 pi 0.84.2 entries 表决定。 */
  readonly message: unknown
}

/** 分页游标(session_id, seq 升序)。 */
export interface MessageEntryCursor {
  readonly sessionId: string
  readonly seq: number
}

export function readAppMeta(m: SqliteSessionMetadata): DaweigeSessionAppMeta | undefined {
  const raw = m.metadata?.['daweige']
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as DaweigeSessionAppMeta).providerId === 'string' &&
    typeof (raw as DaweigeSessionAppMeta).modelId === 'string' &&
    typeof (raw as DaweigeSessionAppMeta).updatedAt === 'number'
  ) {
    return raw as DaweigeSessionAppMeta
  }
  return undefined
}

export class SessionRepository {
  private readonly repo: SqliteSessionRepository
  private readonly databasePath: string

  constructor(databasePath: string) {
    this.databasePath = databasePath
    this.repo = new SqliteSessionRepository({
      env: createNodeSqliteEnv(),
      sqlite: createNodeSqliteFactory(),
      databasePath,
    })
  }

  /** 确保数据库父目录存在;在首次 list/create 前调用一次。 */
  async init(): Promise<void> {
    await fs.mkdir(dirname(this.databasePath), { recursive: true })
  }

  async create(input: {
    cwd: string
    providerId: ProviderId
    modelId: string
    internal?: boolean
  }): Promise<Session<SqliteSessionMetadata>> {
    return this.repo.create({
      cwd: input.cwd,
      metadata: {
        daweige: {
          providerId: input.providerId,
          modelId: input.modelId,
          updatedAt: Date.now(),
          ...(input.internal ? { internal: true as const } : {}),
        } satisfies DaweigeSessionAppMeta,
      },
    })
  }

  async list(): Promise<SqliteSessionMetadata[]> {
    return this.repo.list()
  }

  async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
    return this.repo.open(metadata)
  }

  async delete(metadata: SqliteSessionMetadata): Promise<void> {
    return this.repo.delete(metadata)
  }

  async close(): Promise<void> {
    return this.repo.close()
  }

  /**
   * 惰性分页只读遍历全部会话的 message entries(使用统计回填专用,独立复审 B-01 整改)。
   * 独立只读连接直查 pi 的 entries 表:不 open Session、不取 writer lease;
   * 每页只取 pageSize 行,消费方在批间让出事件循环即不阻塞主线程、内存受控。
   * 行级容错:payload 损坏的行跳过,单行垃圾不中断遍历。
   * pi 三包锁 0.84.2,payload 形态({message: AgentMessage})随版本核验。
   */
  *iterateUsageEntries(pageSize = 500): Generator<UsageEntryRow, void, void> {
    const db = new DatabaseSync(this.databasePath, { readOnly: true })
    try {
      const stmt = db.prepare(
        `SELECT session_id, id, seq, type, timestamp, payload FROM entries
         WHERE type IN ('message', 'compaction')
           AND (session_id > ? OR (session_id = ? AND seq > ?))
         ORDER BY session_id, seq
         LIMIT ?`,
      )
      let cursor: MessageEntryCursor = { sessionId: '', seq: -1 }
      for (;;) {
        const rows = stmt.all(cursor.sessionId, cursor.sessionId, cursor.seq, pageSize) as {
          session_id: string
          id: string
          seq: number
          timestamp: number
          type: 'message' | 'compaction'
          payload: string
        }[]
        if (rows.length === 0) break
        for (const row of rows) {
          cursor = { sessionId: row.session_id, seq: row.seq }
          let payload: Record<string, unknown>
          try {
            const decoded: unknown = JSON.parse(row.payload)
            if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) continue
            payload = decoded as Record<string, unknown>
          } catch {
            continue
          }
          if (row.type === 'message') {
            if (payload.message === undefined) continue
            yield {
              type: 'message',
              sessionId: row.session_id,
              entryId: row.id,
              seq: row.seq,
              timestamp: row.timestamp,
              message: payload.message,
            }
          } else {
            if (typeof payload.summary !== 'string' || !Array.isArray(payload.retainedTail)) continue
            if (typeof payload.tokensBefore !== 'number') continue
            yield {
              type: 'compaction',
              sessionId: row.session_id,
              entryId: row.id,
              seq: row.seq,
              timestamp: row.timestamp,
              entry: {
                type: 'compaction',
                id: row.id,
                seq: row.seq,
                parentId: null,
                timestamp: row.timestamp,
                summary: payload.summary,
                retainedTail: payload.retainedTail as CompactionEntry['retainedTail'],
                tokensBefore: payload.tokensBefore,
                ...(payload.usage ? { usage: payload.usage as CompactionEntry['usage'] } : {}),
                ...(payload.details !== undefined ? { details: payload.details } : {}),
              },
            }
          }
        }
      }
    } finally {
      db.close()
    }
  }

  /** @deprecated A-29 起 usage 回填须覆盖 compaction；旧名转发新迭代器。 */
  *iterateMessageEntries(pageSize = 500): Generator<UsageEntryRow, void, void> {
    yield* this.iterateUsageEntries(pageSize)
  }
}
