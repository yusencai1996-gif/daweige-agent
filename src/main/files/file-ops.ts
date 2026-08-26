import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { PathPolicy } from './path-policy'
import { PathPolicyError } from './path-policy'
import { isStrictDelegationPathPolicy } from './path-policy'

/**
 * 文件操作执行层(M4-03/04)。
 * 纵深防御:就算确认层被绕过,这里仍守住两条底线——
 * 1. 应用内部数据(userData)绝不允许工具读写;
 * 2. 写目标禁含通配符/保留字符。
 * 批量操作先全量预检,再逐项执行,返回逐项结果(部分失败不回滚,R-09 如实上报)。
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 单文件读取上限 2MB

export interface FileItem {
  name: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: number
}

export class FileOpsError extends Error {
  constructor(
    public readonly code: 'too_large' | 'binary' | 'not_found' | 'app_internal' | 'fs_error',
    message: string,
  ) {
    super(message)
  }
}

export class FileOps {
  constructor(private readonly policy: PathPolicy) {}

  /** 读文本(txt/md/csv):UTF-8 优先,BOM 剥离;超限/二进制给可读错误。 */
  async readText(path: string): Promise<string> {
    await this.assertReadableTarget(path, 'read_file')
    const stat = await fs.stat(path).catch(() => {
      throw new FileOpsError('not_found', `文件不存在:${path}`)
    })
    if (stat.size > MAX_TEXT_BYTES) {
      throw new FileOpsError('too_large', `文件太大(${Math.round(stat.size / 1024 / 1024)}MB,上限 2MB),请分段处理或换更小的文件`)
    }
    const buf = await fs.readFile(path)
    if (looksBinary(buf)) {
      throw new FileOpsError('binary', '这是二进制文件,不是文本;Word/Excel 请用对应的读取工具')
    }
    return stripBom(buf.toString('utf-8'))
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.assertWritableTarget(path, 'write_file')
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, content, 'utf-8')
  }

  async listDirectory(path: string): Promise<FileItem[]> {
    await this.assertReadableTarget(path, 'list_directory')
    const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => {
      throw new FileOpsError('not_found', `文件夹不存在:${path}`)
    })
    const items = await Promise.all(
      entries.map(async (e): Promise<FileItem> => {
        const full = join(path, e.name)
        if (e.isDirectory()) {
          return { name: e.name, type: 'directory', size: 0, modifiedAt: 0 }
        }
        const st = await fs.stat(full).catch(() => null)
        return {
          name: e.name,
          type: 'file' as const,
          size: st?.size ?? 0,
          modifiedAt: st?.mtimeMs ?? 0,
        }
      }),
    )
    return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  async makeDirectory(path: string): Promise<void> {
    await this.assertWritableTarget(path, 'make_directory')
    await fs.mkdir(path, { recursive: true })
  }

  /**
   * 批量移动(M4-04 + 复审 S-03):先全量预检(源存在/目标无重名),
   * 预检不过全部不执行;执行期失败才出现部分成功,逐项如实上报。
   */
  async movePaths(paths: string[], destinationDir: string): Promise<ItemResult[]> {
    await this.assertStrictBatch([...paths, destinationDir], 'move_paths', 'write')
    await this.assertWritableTarget(destinationDir, 'move_paths')
    for (const p of paths) await this.assertWritableTarget(p, 'move_paths')

    // 预检 1:全部源必须存在
    for (const p of paths) {
      if (!(await this.fileExists(p))) {
        return paths.map((q) => ({
          path: q,
          ok: false,
          error: q === p ? '文件或文件夹不存在(预检失败,本次未执行任何移动)' : '预检失败,本次未执行',
        }))
      }
    }
    // 预检 2:目标目录里不能已有同名项(避免静默覆盖)
    for (const p of paths) {
      const dest = join(destinationDir, basename(p))
      if (await this.fileExists(dest)) {
        return paths.map((q) => ({
          path: q,
          ok: false,
          error:
            q === p
              ? `目标文件夹里已有同名项目「${basename(p)}」(预检失败,本次未执行任何移动)`
              : '预检失败,本次未执行',
        }))
      }
    }

    await fs.mkdir(destinationDir, { recursive: true })
    const results: ItemResult[] = []
    for (const p of paths) {
      const dest = join(destinationDir, basename(p))
      try {
        await fs.rename(p, dest)
        results.push({ path: p, ok: true })
      } catch (err) {
        results.push({ path: p, ok: false, error: describeFsError(err) })
      }
    }
    return results
  }

  async renamePath(path: string, newName: string): Promise<string> {
    if (/[\\/:]/.test(newName)) {
      throw new FileOpsError('fs_error', '新名字不能包含路径分隔符,只能改名字本身')
    }
    const dest = join(path, '..', newName)
    await this.assertStrictBatch([path, dest], 'rename_path', 'write')
    await this.assertWritableTarget(path, 'rename_path')
    await this.assertWritableTarget(dest, 'rename_path')
    await fs.rename(path, dest)
    return dest
  }

  /** 删除走 Windows 回收站(由注入的 trash 函数实现,便于测试);先预检存在性。 */
  async deletePaths(paths: string[], trash: (p: string) => Promise<void>): Promise<ItemResult[]> {
    await this.assertStrictBatch(paths, 'delete_paths', 'write')
    for (const p of paths) await this.assertWritableTarget(p, 'delete_paths')
    const results: ItemResult[] = []
    for (const p of paths) {
      if (!(await this.fileExists(p))) {
        results.push({ path: p, ok: false, error: '文件或文件夹不存在' })
        continue
      }
      try {
        await trash(p)
        results.push({ path: p, ok: true })
      } catch (err) {
        results.push({ path: p, ok: false, error: describeFsError(err) })
      }
    }
    return results
  }

  /** 编辑:精确匹配唯一 old_string 才替换(Claude Code 考察的正确性三件套之一)。 */
  async editText(path: string, oldString: string, newString: string): Promise<number> {
    const text = await this.readText(path)
    const count = text.split(oldString).length - 1
    if (count === 0) {
      throw new FileOpsError('not_found', `没找到要改的内容(原文片段不存在):${oldString.slice(0, 50)}…`)
    }
    if (count > 1) {
      throw new FileOpsError(
        'fs_error',
        `要改的内容出现了 ${count} 次,不确定改哪个;请提供更长、更唯一的原文片段`,
      )
    }
    const next = text.replace(oldString, newString)
    await this.writeText(path, next)
    return count
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await fs.stat(path)
      return true
    } catch {
      return false
    }
  }

  async readBinary(path: string): Promise<Buffer> {
    await this.assertReadableTarget(path, 'read_binary')
    const stat = await fs.stat(path).catch(() => {
      throw new FileOpsError('not_found', `文件不存在:${path}`)
    })
    if (stat.size > 20 * 1024 * 1024) {
      throw new FileOpsError('too_large', `文件太大(${Math.round(stat.size / 1024 / 1024)}MB,上限 20MB)`)
    }
    return fs.readFile(path)
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.assertWritableTarget(path, 'write_binary')
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, data)
  }

  private async assertReadableTarget(path: string, toolName: string): Promise<void> {
    await this.assertStrictBatch([path], toolName, 'read')
    const { zone } = await this.policy.classify(path)
    if (zone === 'app-internal') {
      throw new FileOpsError('app_internal', '应用内部数据不允许通过文件工具访问')
    }
  }

  private async assertWritableTarget(path: string, toolName: string): Promise<void> {
    this.policy.assertWritable(path)
    await this.assertStrictBatch([path], toolName, 'write')
    const { zone } = await this.policy.classify(path)
    if (zone === 'app-internal') {
      throw new FileOpsError('app_internal', '应用内部数据不允许写入')
    }
  }

  private async assertStrictBatch(
    paths: readonly string[],
    toolName: string,
    operation: 'read' | 'write',
  ): Promise<void> {
    if (!isStrictDelegationPathPolicy(this.policy)) return
    const result = await this.policy.preflight(paths, toolName, operation)
    if (!result.allowed) throw new FileOpsError('fs_error', result.reason)
  }
}

export interface ItemResult {
  path: string
  ok: boolean
  error?: string
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / Math.max(sample.length, 1) > 0.1
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function describeFsError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message ?? ''
    if (/ENOENT/.test(msg)) return '文件或文件夹不存在'
    if (/EPERM|EACCES/.test(msg)) return '没有权限操作'
    if (/ENOTEMPTY/.test(msg)) return '文件夹不是空的'
    if (/EBUSY/.test(msg)) return '文件正被别的程序占用'
    if (err instanceof PathPolicyError) return msg
    return msg.slice(0, 80)
  }
  return String(err).slice(0, 80)
}
