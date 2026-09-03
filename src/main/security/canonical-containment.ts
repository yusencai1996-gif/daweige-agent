import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface CanonicalContainmentFs {
  readonly lstat: typeof lstat
  readonly mkdir: typeof mkdir
  readonly realpath: typeof realpath
}

const nodeFs: CanonicalContainmentFs = { lstat, mkdir, realpath }

/** 从可信 daweige 根逐层建目录并复检 canonical path；任何链接/junction 或越界均 fail closed。 */
export async function ensureCanonicalDirectory(
  trustedRoot: string,
  target: string,
  fs: CanonicalContainmentFs = nodeFs,
): Promise<string> {
  const root = resolve(trustedRoot)
  const candidate = resolve(target)
  assertLexicallyWithin(root, candidate)
  await ensureRoot(root, fs)
  const rootReal = await checkedRealpath(root, fs)
  let current = root
  const rel = relative(root, candidate)
  for (const part of rel ? rel.split(/[\\/]/u) : []) {
    current = join(current, part)
    await createSegmentIfMissing(current, fs)
    await assertSafeExisting(current, rootReal, fs)
  }
  // 创建结束后从根重走一遍，捕获 mkdir 前后被替换的祖先。
  await assertCanonicalContainment(root, candidate, fs)
  return candidate
}

/** 只检查现存祖先；目标可尚不存在，但可信根必须是安全实目录。 */
export async function assertCanonicalContainment(
  trustedRoot: string,
  candidatePath: string,
  fs: CanonicalContainmentFs = nodeFs,
): Promise<void> {
  const root = resolve(trustedRoot)
  const candidate = resolve(candidatePath)
  assertLexicallyWithin(root, candidate)
  const rootReal = await checkedRealpath(root, fs)
  let current = root
  await assertSafeExisting(current, rootReal, fs)
  const parts = (relative(root, candidate) || '').split(/[\\/]/u).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    try { await assertSafeExisting(current, rootReal, fs, index < parts.length - 1) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** 从已知应用管理路径反推出固定的 <userData>/daweige 根。 */
export function daweigeRootForManagedPath(path: string): string {
  let current = resolve(path)
  while (dirname(current) !== current) {
    if (basename(current).toLocaleLowerCase() === 'daweige') return current
    current = dirname(current)
  }
  throw new Error('路径不在大微阁管理目录中。')
}

async function ensureRoot(root: string, fs: CanonicalContainmentFs): Promise<void> {
  try { await fs.lstat(root) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.mkdir(root, { recursive: true })
  }
  await checkedRealpath(root, fs)
}

async function createSegmentIfMissing(path: string, fs: CanonicalContainmentFs): Promise<void> {
  try { await fs.lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.mkdir(path, { recursive: false })
  }
}

async function checkedRealpath(path: string, fs: CanonicalContainmentFs, requireDirectory = true): Promise<string> {
  const info = await fs.lstat(path)
  if (
    info.isSymbolicLink()
    || (requireDirectory ? !info.isDirectory() : (!info.isDirectory() && !info.isFile()))
  ) throw new Error('应用管理目录包含链接或不是普通文件/文件夹，已拒绝操作。')
  return fs.realpath(path)
}

async function assertSafeExisting(path: string, rootReal: string, fs: CanonicalContainmentFs, requireDirectory = true): Promise<void> {
  const currentReal = await checkedRealpath(path, fs, requireDirectory)
  assertLexicallyWithin(rootReal, currentReal)
}

function assertLexicallyWithin(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('目录越过了应用管理范围。')
  }
}
