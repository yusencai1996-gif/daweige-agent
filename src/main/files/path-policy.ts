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

export interface DelegationPathViolation {
  /** 已解开 Junction/symlink、并补回待创建尾段的规范路径。 */
  readonly path: string
  readonly toolName: string
  readonly operation: 'read' | 'write'
  readonly occurredAt: number
  readonly reason: string
}

export type DelegationViolationReporter = (
  violation: DelegationPathViolation,
) => void | Promise<void>

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
  protected readonly workspaceReal: Promise<string>
  protected readonly appDataReal: Promise<string>

  constructor(
    workspacePath: string,
    userDataPath: string,
  ) {
    this.workspaceReal = realOfExisting(workspacePath, '工作文件夹')
    this.appDataReal = realOfExisting(userDataPath, '应用数据目录')
  }

  /** 判定目标路径所在区域。对不存在的目标取最近现存父目录的真实路径。 */
  async classify(targetPath: string): Promise<PathCheckResult> {
    const abs = toAbsolute(targetPath)
    const real = await realWithMissingTail(abs)
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
    const abs = toAbsolute(targetPath)
    const tail = abs.split(/[\\/]/).pop() ?? ''
    if (WRITE_FORBIDDEN.test(tail)) {
      throw new PathPolicyError(
        'invalid_chars',
        `文件名包含不允许的字符(如 * ? | < >):${tail}`,
      )
    }
  }

}

/**
 * delegated child 专用严格路径域。它与普通 PathPolicy 分类,
 * 避免调用方漏传 mode 时意外放宽安全边界。
 */
export class StrictDelegationPathPolicy extends PathPolicy {
  readonly strictDelegation = true
  /** spawn 批准时已经 realpath 过的快照；绝不能用执行时的新 realpath 替换授权事实。 */
  private readonly approvedRoots: readonly string[]

  constructor(
    workspacePaths: readonly string[],
    userDataPath: string,
    private readonly reportViolation?: DelegationViolationReporter,
  ) {
    if (workspacePaths.length === 0) {
      throw new PathPolicyError('not_found', '派活允许路径不能为空')
    }
    super(workspacePaths[0]!, userDataPath)
    this.approvedRoots = workspacePaths.map((path) => toAbsolute(path))
  }

  override async classify(targetPath: string): Promise<PathCheckResult> {
    const roots = await this.validatedRoots()
    return this.classifyWithRoots(targetPath, roots)
  }

  private async classifyWithRoots(
    targetPath: string,
    roots: readonly string[],
  ): Promise<PathCheckResult> {
    const real = await realWithMissingTail(toAbsolute(targetPath))
    const appData = await this.appDataReal
    if (isInside(real, appData)) return { zone: 'app-internal', realPath: real }
    if (roots.some((root) => isInside(real, root))) {
      return { zone: 'workspace', realPath: real }
    }
    return { zone: 'outside', realPath: real }
  }

  /**
   * 全量预检一次完成;有一项越界则返回同一个 block reason,
   * 并为每个越界项记录主进程权威 violation。
   */
  async preflight(
    paths: readonly string[],
    toolName: string,
    operation: 'read' | 'write',
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    let roots: readonly string[]
    try {
      // 一次批量预检只核对每个 root 一次，避免 paths × roots 的重复 IO。
      roots = await this.validatedRoots()
    } catch (error) {
      const reason = rootInvalidMessage(error)
      for (const attempted of paths) {
        await this.reportViolation?.({
          path: safeCanonicalAttempt(attempted),
          toolName,
          operation,
          occurredAt: Date.now(),
          reason,
        })
      }
      return { allowed: false, reason }
    }
    const checks = await Promise.all(
      paths.map(async (attempted) => {
        try {
          const result = await this.classifyWithRoots(attempted, roots)
          return { attempted, ...result }
        } catch (error) {
          return { attempted, error }
        }
      }),
    )
    const blocked = checks.filter(
      (item) => 'error' in item || ('zone' in item && item.zone !== 'workspace'),
    )
    if (blocked.length === 0) return { allowed: true }

    for (const item of blocked) {
      const canonical =
        'realPath' in item && typeof item.realPath === 'string'
          ? item.realPath
          : safeCanonicalAttempt(item.attempted)
      const reason =
        'zone' in item && item.zone === 'app-internal'
          ? '派活子角色不允许访问应用内部数据'
          : '路径不在本次派活允许的文件夹内'
      await this.reportViolation?.({
        path: canonical,
        toolName,
        operation,
        occurredAt: Date.now(),
        reason,
      })
    }
    return {
      allowed: false,
      reason: `已阻止 ${toolName}:有 ${blocked.length} 个路径超出本次派活允许范围`,
    }
  }

  private async validatedRoots(): Promise<readonly string[]> {
    const current = await Promise.all(
      this.approvedRoots.map(async (approved) => {
        try {
          return await fs.realpath(approved)
        } catch {
          throw new PathPolicyError(
            'not_found',
            '允许的文件夹在批准后被移动或替换,为安全起见这次不执行',
          )
        }
      }),
    )
    if (current.some((root, index) => normalize(root) !== normalize(this.approvedRoots[index]!))) {
      throw new PathPolicyError(
        'fs_error',
        '允许的文件夹在批准后被移动或替换,为安全起见这次不执行',
      )
    }
    return this.approvedRoots
  }
}

export function isStrictDelegationPathPolicy(
  policy: PathPolicy,
): policy is StrictDelegationPathPolicy {
  return policy instanceof StrictDelegationPathPolicy
}

function toAbsolute(p: string): string {
  if (!isAbsolute(p)) {
    throw new PathPolicyError('not_absolute', `只允许绝对路径:${p}`)
  }
  return resolve(p)
}

async function realOfExisting(p: string, label: string): Promise<string> {
  try {
    return await fs.realpath(toAbsolute(p))
  } catch {
    throw new PathPolicyError('not_found', `${label}不存在:${p}`)
  }
}

/** 现存路径直接 realpath;不存在的沿父目录找最近现存,拼回剩余段。 */
async function realWithMissingTail(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    // 不存在:父目录逐级上找
  }
  const parent = dirname(p)
  if (parent === p) {
    throw new PathPolicyError('not_found', `路径不可达:${p}`)
  }
  const parentReal = await realWithMissingTail(parent)
  const tail = p.slice(parent.length).replace(/^[\\/]+/, '')
  return join(parentReal, tail)
}

function safeCanonicalAttempt(path: string): string {
  try {
    return toAbsolute(path)
  } catch {
    return path
  }
}

function rootInvalidMessage(error: unknown): string {
  return error instanceof PathPolicyError &&
    error.message === '允许的文件夹在批准后被移动或替换,为安全起见这次不执行'
    ? error.message
    : '允许的文件夹在批准后被移动或替换,为安全起见这次不执行'
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
