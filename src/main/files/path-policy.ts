import { promises as fs } from 'node:fs'
import { isAbsolute, resolve, sep, dirname, join } from 'node:path'

/**
 * Windows 路径安全策略(M4-01)。
 *
 * 铁律:
 * - 区域判定一律基于真实路径(realpath,解开 Junction/symlink),绝不用字符串前缀;
 * - 待创建目标:取最近现存父目录的 realpath 再拼回剩余段;
 * - 工作区边界必须落在路径分隔符上(防 C:\\work 吃掉 C:\\workspace);
 * - Windows 大小写不敏感:统一小写比对;
 * - 写操作目标禁含通配符/保留字符。
 */

export type PathZone = 'workspace' | 'outside' | 'app-internal'

export interface PathCheckResult {
  zone: PathZone
  /** 规范化后的真实路径(可能含待创建的尾部段)。 */
  realPath: string
}

export class PathPolicyError extends Error {
  constructor(
    public readonly reason:
      | 'not_absolute'
      | 'invalid_chars'
      | 'not_found'
      | 'fs_error',
    message: string,
  ) {
    super(message)
  }
}

/** Windows 写目标禁止的通配符与保留字符(< > : " | ? *,以及控制字符)。 */
const WRITE_FORBIDDEN = /[\x00-\x1f<>:"|?*]/

export class PathPolicy {
  private readonly workspaceReal: Promise<string>
  private readonly appDataReal: Promise<string>

  constructor(
    workspacePath: string,
    userDataPath: string,
  ) {
    this.workspaceReal = this.realOfExisting(workspacePath, '工作文件夹')
    this.appDataReal = this.realOfExisting(userDataPath, '应用数据目录')
  }

  /** 判定目标路径所在区域。对不存在的目标取最近现存父目录的真实路径。 */
  async classify(targetPath: string): Promise<PathCheckResult> {
    const abs = this.toAbsolute(targetPath)
    const real = await this.realWithMissingTail(abs)
    const workspace = await this.workspaceReal
    const appData = await this.appDataReal

    if (isInside(real, appData)) {
      return { zone: 'app-internal', realPath: real }
    }
    if (isInside(real, workspace)) {
      return { zone: 'workspace', realPath: real }
    }
    return { zone: 'outside', realPath: real }
  }

  /** 写操作目标的额外校验:禁通配符/保留字符(尾段文件名也查)。 */
  assertWritable(targetPath: string): void {
    const abs = this.toAbsolute(targetPath)
    const tail = abs.split(/[\\/]/).pop() ?? ''
    if (WRITE_FORBIDDEN.test(tail)) {
      throw new PathPolicyError(
        'invalid_chars',
        `文件名包含不允许的字符(如 * ? | < >):${tail}`,
      )
    }
  }

  private toAbsolute(p: string): string {
    if (!isAbsolute(p)) {
      throw new PathPolicyError('not_absolute', `只允许绝对路径:${p}`)
    }
    return resolve(p)
  }

  private async realOfExisting(p: string, label: string): Promise<string> {
    try {
      return await fs.realpath(p)
    } catch {
      throw new PathPolicyError('not_found', `${label}不存在:${p}`)
    }
  }

  /** 现存路径直接 realpath;不存在的沿父目录找最近现存,拼回剩余段。 */
  private async realWithMissingTail(p: string): Promise<string> {
    try {
      return await fs.realpath(p)
    } catch {
      // 不存在:父目录逐级上找
    }
    const parent = dirname(p)
    if (parent === p) {
      throw new PathPolicyError('not_found', `路径不可达:${p}`)
    }
    const parentReal = await this.realWithMissingTail(parent)
    const tail = p.slice(parent.length).replace(/^[\\/]+/, '')
    return join(parentReal, tail)
  }
}

/** 大小写不敏感 + 分隔符边界的包含判断。realPath/parent 均为已规范化的真实路径。 */
export function isInside(realPath: string, parent: string): boolean {
  const a = normalize(realPath)
  const b = normalize(parent)
  if (a === b) return true
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function normalize(p: string): string {
  return p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')
}
