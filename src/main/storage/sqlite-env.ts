import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { FileError } from '@earendil-works/pi-agent-core'
import type { SqliteSessionRepositoryEnv } from '@earendil-works/pi-session-backend-sqlite-node'

/**
 * pi SQLite 会话仓库的 Node 环境适配(M2-05)。
 * SqliteSessionRepositoryEnv 只需要三个能力:absolutePath / createDir / exists,
 * 返回 pi 的 Result 形态({ok:true,value}|{ok:false,error:FileError})。
 */

export function createNodeSqliteEnv(): SqliteSessionRepositoryEnv {
  return {
    absolutePath: async (path) => ({ ok: true, value: resolve(path) }),
    createDir: async (path, options) => {
      try {
        await fs.mkdir(path, { recursive: options?.recursive ?? true })
        return { ok: true, value: undefined }
      } catch (error) {
        return { ok: false, error: toFileError(error, path) }
      }
    },
    exists: async (path) => {
      try {
        return { ok: true, value: await fileExists(path) }
      } catch (error) {
        return { ok: false, error: toFileError(error, path) }
      }
    },
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

function toFileError(error: unknown, path: string): FileError {
  return new FileError('unknown', error instanceof Error ? error.message : String(error), path)
}
