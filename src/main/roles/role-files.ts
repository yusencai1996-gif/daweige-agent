import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { RoleProfile } from '../../shared/domain'
import { isValidRoleId } from './role-id'
import { seedDefaultSkillIntoHome } from '../skills/default-skill-seeder'

/**
 * 角色家目录文件层(PLAN §2.4/§2.5)。
 *
 * 目录契约:
 *   <userData>/daweige/agents/<roleId>/profile.json|guardrails.md|resources/|extensions/{skills,mcp}/
 *   <userData>/daweige/staging/<runId>/          创建/迁移临时区,提升或清理
 *
 * 安全红线:
 * - 家目录名只能由 roleId 派生(isValidRoleId 拒绝 ../ 与任意伪造格式);
 * - 删除前的路径校验必须过 realpath 且严格位于 agents 根内;
 * - 所有落盘走「临时文件 + rename」原子替换,失败不留半文件。
 */

/** 守则篇幅口径:推荐 2000 字内,硬上限 6000 字 / 24 KiB。 */
export const GUARDRAILS_MAX_CHARS = 6_000
export const GUARDRAILS_RECOMMENDED_CHARS = 2_000
export const GUARDRAILS_MAX_BYTES = 24 * 1024

export interface GuardrailsCheck {
  readonly ok: boolean
  readonly chars: number
  readonly bytes: number
  readonly message?: string
}

export function checkGuardrails(content: string): GuardrailsCheck {
  const chars = [...content].length
  const bytes = Buffer.byteLength(content, 'utf8')
  if (chars > GUARDRAILS_MAX_CHARS) {
    return {
      ok: false,
      chars,
      bytes,
      message: `守则超长:${chars} 字,最多 ${GUARDRAILS_MAX_CHARS} 字,请精简后再保存`,
    }
  }
  if (bytes > GUARDRAILS_MAX_BYTES) {
    return { ok: false, chars, bytes, message: `守则超长:${bytes} 字节,最多 24 KiB,请精简后再保存` }
  }
  // 硬限内但超推荐篇幅:可保存,附上下文占用提醒
  const message =
    chars > GUARDRAILS_RECOMMENDED_CHARS
      ? `守则 ${chars} 字,超过推荐的 ${GUARDRAILS_RECOMMENDED_CHARS} 字,会占用更多上下文`
      : undefined
  return { ok: true, chars, bytes, message }
}

/** agents 根与 staging 根(固定相对布局)。 */
export function agentsRoot(userDataPath: string): string {
  return join(userDataPath, 'daweige', 'agents')
}

export function stagingRoot(userDataPath: string): string {
  return join(userDataPath, 'daweige', 'staging')
}

/** roleId → 家目录绝对路径;roleId 格式不过关直接抛(防路径注入)。 */
export function roleHomePath(userDataPath: string, roleId: string): string {
  if (!isValidRoleId(roleId)) {
    throw new Error(`非法角色 ID:${roleId}`)
  }
  return join(agentsRoot(userDataPath), roleId)
}

/** 新建 staging 目录并写好 profile+guardrails;返回 staging 路径(尚未提升)。 */
export async function stageRoleHome(
  userDataPath: string,
  profile: RoleProfile,
  guardrails: string,
): Promise<string> {
  const runId = randomBytes(8).toString('hex')
  const stagingDir = join(stagingRoot(userDataPath), runId)
  await mkdir(join(stagingDir, 'resources'), { recursive: true })
  await mkdir(join(stagingDir, 'extensions', 'skills'), { recursive: true })
  await mkdir(join(stagingDir, 'extensions', 'mcp'), { recursive: true })
  await mkdir(join(stagingDir, 'memory'), { recursive: true })
  await atomicWriteJson(join(stagingDir, 'profile.json'), profile)
  await atomicWriteText(join(stagingDir, 'guardrails.md'), guardrails)
  await seedDefaultSkillIntoHome(stagingDir, profile.templateId)
  return stagingDir
}

/** 把 staging 家目录原子提升到 agents/<roleId>;staging 与目标同卷(userData 下),rename 原子。 */
export async function promoteRoleHome(userDataPath: string, stagingDir: string, roleId: string): Promise<string> {
  const target = roleHomePath(userDataPath, roleId)
  await mkdir(dirname(target), { recursive: true })
  await rename(stagingDir, target)
  return target
}

/** 清理本次 staging(提交或失败后);只删 staging 根内自己的目录,绝不碰 agents。 */
export async function cleanupStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true })
}

export async function readProfile(homeDir: string): Promise<RoleProfile> {
  const raw = await readFile(join(homeDir, 'profile.json'), 'utf8')
  return JSON.parse(raw) as RoleProfile
}

export async function readGuardrails(homeDir: string): Promise<string> {
  return readFile(join(homeDir, 'guardrails.md'), 'utf8')
}

/** 守则原子写:临时文件 + rename;成功后由调用方递增 guardrails_version。 */
export async function writeGuardrails(homeDir: string, content: string): Promise<void> {
  await atomicWriteText(join(homeDir, 'guardrails.md'), content)
}

/**
 * 删除前的家目录安全校验(PLAN §5.3 步骤 6):
 * realpath 必须严格位于 agents 根内,且 basename === roleId;任何越界/链接逃逸拒绝。
 */
export async function validateHomeDirForDelete(userDataPath: string, roleId: string): Promise<string | null> {
  if (!isValidRoleId(roleId)) {
    throw new Error(`非法角色 ID:${roleId}`)
  }
  const root = resolve(agentsRoot(userDataPath))
  const expected = join(root, roleId)
  const { realpath } = await import('node:fs/promises')
  let real: string
  try {
    real = await realpath(expected)
  } catch (err) {
    // 家目录已不存在=删除状态机的已完成阶段(上轮删了目录、注册行没删就中断):
    // 幂等视为成功,让流程继续走"最后事务清行",不在同一点永久卡死
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  // 统一小写比较:realpath 返回磁盘真实大小写,root 是词法拼写,Junction/大小写
  // 变体的 userData 下字符串精确比较会恒不相等(专审建议,防"删不掉"方向误拒)
  if (dirname(real).toLowerCase() !== root.toLowerCase() || basename(real) !== roleId) {
    throw new Error('角色家目录校验失败:路径越界或名称不符,拒绝删除')
  }
  return real
}

/** 删除家目录(幂等:已不存在直接成功);node fs.rm 对目录内 symlink 只删链接本身,不跟随越界递归。 */
export async function removeRoleHome(userDataPath: string, roleId: string): Promise<void> {
  const real = await validateHomeDirForDelete(userDataPath, roleId)
  if (real === null) return
  await rm(real, { recursive: true, force: true })
}

// ---------- 路径规范化(挂载去重键,PLAN §4.2)----------

/**
 * 挂载目录 canonical key:存在的目录 realpath(解开 Junction/symlink)后规范化;
 * 不存在的目录用词法规范化兜底(mount 标 missing,角色仍建)。
 * Windows 规则:统一为小写、正斜杠、去尾斜杠——大小写/分隔符差异归并为同一挂载。
 */
export async function canonicalWorkspaceKey(workspacePath: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  let resolved: string
  try {
    resolved = await realpath(resolve(workspacePath))
  } catch {
    resolved = resolve(workspacePath)
  }
  return normalizeKey(resolved)
}

export function normalizeKey(p: string): string {
  let key = p.split(sep).join('/')
  if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  return key.toLowerCase()
}

// ---------- 原子写 ----------

async function atomicWriteText(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, target)
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`)
}
