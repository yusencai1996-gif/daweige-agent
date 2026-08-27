import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ManagerWorkspaceState } from '../../shared/domain/manager-workspace'
import type { Settings } from '../../shared/domain/settings'
import type { SettingsStore } from '../storage/settings-store'
import { ManagerWorkspaceResolver } from './resolver'

/** 迁移校验失败(路径不合法/嵌套/非空目标等)。 */
export class ManagerWorkspaceMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagerWorkspaceMigrationError'
  }
}

interface FileManifestEntry {
  readonly relPath: string
  readonly size: number
}

/**
 * 总管工作区迁移服务——0.4.0 A(A-14)。
 * 流程:校验目标 → 全量拷贝(含 manifest)→ 逐文件校验 → 提交(settings 写入覆盖路径)
 * → 清理旧目录(失败不回滚,新位置数据已完整,旧副本留着无害,给 cleanupWarning)。
 * 中断安全:commit 前任何失败都不会改 settings,旧目录原样;commit 后 cleanup 失败只留副本。
 */
export class ManagerWorkspaceMigrationService {
  constructor(
    private readonly resolver: ManagerWorkspaceResolver,
    private readonly settingsStore: SettingsStore,
  ) {}

  async currentState(): Promise<ManagerWorkspaceState> {
    return {
      effectivePath: this.resolver.resolveForDisplay(),
      isDefault: this.resolver.isDefault(),
      restartRequired: false,
    }
  }

  /** 迁移(也用于"恢复默认":targetPath=默认路径)。 */
  async migrate(targetPath: string): Promise<ManagerWorkspaceState> {
    const target = this.validateTarget(targetPath)
    const source = this.resolver.resolveForDisplay()
    if (resolve(target) === resolve(source)) {
      throw new ManagerWorkspaceMigrationError('目标文件夹就是当前工作文件夹,不用迁移')
    }
    // 嵌套互斥(相对当前 effective 源,而非写死默认路径——"恢复默认"必须放行)。
    // 不能用 path.relative 的 ".." 前缀判断:Windows 跨盘符(C 盘默认位置 → F/D 盘,
    // A-14 的核心场景)时 relative 返回目标绝对路径而非 ../..,所有跨盘迁移都会被
    // 误判成"目标在源里面"(用户 0827 真机实踩)。改用盘符归一的包含判定。
    if (pathContains(source, target)) {
      throw new ManagerWorkspaceMigrationError(
        `目标不能选在小柊当前的工作文件夹里面(你选的是:${target})`,
      )
    }
    if (pathContains(target, source)) {
      throw new ManagerWorkspaceMigrationError(
        `目标不能包含小柊当前的工作文件夹(当前是:${source})`,
      )
    }

    const sourceExists = await exists(source)
    if (sourceExists) {
      const manifest = await this.scanManifest(source)
      await this.copyAll(source, target, manifest)
      const verified = await this.verifyManifest(target, manifest)
      if (!verified.ok) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        throw new ManagerWorkspaceMigrationError(
          `迁移校验没通过(${verified.reason}),已取消;原工作文件夹没有动`,
        )
      }
    } else {
      // 源不存在(首次/已迁走):只建目标目录
      await mkdir(target, { recursive: true })
    }

    // commit:写 settings(原子写,SettingsStore 保证)。
    // 恢复默认(目标=默认路径)= 清掉覆盖字段,而不是把默认绝对串写进去。
    const isDefaultTarget = resolve(target) === resolve(this.resolver.defaultPath())
    const settings = await this.settingsStore.load()
    await this.settingsStore.save(
      isDefaultTarget
        ? { ...settings, managerWorkspacePath: undefined }
        : { ...settings, managerWorkspacePath: target },
    )

    // cleanup:删旧 workspace(仅当旧目录真实存在且不是目标)
    let cleanupWarning: string | undefined
    if (sourceExists && resolve(source) !== resolve(target)) {
      const removed = await rm(source, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false)
      if (!removed) {
        cleanupWarning = `旧工作文件夹没能自动清理(${source});里面的内容已完整复制到新位置,可手动删除`
      }
    }

    return {
      effectivePath: normalizeTarget(target),
      isDefault: resolve(target) === resolve(this.resolver.defaultPath()),
      restartRequired: false,
      cleanupWarning,
    }
  }

  /** 目标基础校验:realpath 归一+长度。嵌套/同路径互斥在 migrate 里相对当前源判定。 */
  private validateTarget(targetPath: string): string {
    const target = resolve(targetPath.trim())
    if (target.length < 2) {
      throw new ManagerWorkspaceMigrationError('目标路径不合法')
    }
    return target
  }

  private async scanManifest(source: string): Promise<readonly FileManifestEntry[]> {
    const entries: FileManifestEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      const children = await readdir(dir, { withFileTypes: true })
      for (const child of children) {
        const childPath = join(dir, child.name)
        if (child.isDirectory()) {
          await walk(childPath)
        } else if (child.isFile()) {
          const info = await stat(childPath)
          entries.push({ relPath: relative(source, childPath), size: info.size })
        }
        // 符号链接跳过不拷贝(不跟随,防逃逸;工作区内正常不出现)
      }
    }
    await walk(source)
    return entries
  }

  private async copyAll(
    source: string,
    target: string,
    manifest: readonly FileManifestEntry[],
  ): Promise<void> {
    // 目标必须为空或不存在(防覆盖用户已有文件)
    if (await exists(target)) {
      const existing = await readdir(target)
      if (existing.length > 0) {
        throw new ManagerWorkspaceMigrationError('目标文件夹不是空的;请选一个空文件夹(或新建一个)')
      }
    } else {
      // 建 target 本身(空工作区时没有文件会顺带建目录;dirname 在盘根会 EPERM)
      await mkdir(target, { recursive: true })
    }
    for (const entry of manifest) {
      const dest = join(target, entry.relPath)
      await mkdir(dirname(dest), { recursive: true })
      // 纯拷贝,绝不移动源文件:commit 失败时 rm 目标即可安全取消,源目录原样。
      // (目标目录已保证为空,copyFile 无覆盖风险)
      await copyFile(join(source, entry.relPath), dest)
    }
  }

  private async verifyManifest(
    target: string,
    manifest: readonly FileManifestEntry[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (manifest.length === 0) return { ok: true }
    for (const entry of manifest) {
      const dest = join(target, entry.relPath)
      try {
        const info = await stat(dest)
        if (info.size !== entry.size) {
          return { ok: false, reason: `${entry.relPath} 大小不一致` }
        }
      } catch {
        return { ok: false, reason: `${entry.relPath} 缺失` }
      }
    }
    return { ok: true }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function normalizeTarget(target: string): string {
  return target
}

export type { Settings }

/** 路径包含判定(parent === child 或 child 在 parent 之内);跨盘符自然不包含。 */
function pathContains(parent: string, child: string): boolean {
  const norm = (p: string): string => resolve(p).toLowerCase().replace(/[\\/]+$/, '')
  const p = norm(parent)
  const c = norm(child)
  if (p === c) return true
  return c.startsWith(p + '\\') || c.startsWith(p + '/')
}
