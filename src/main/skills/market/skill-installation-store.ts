import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadSourcedSkills } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { SkillProvenance } from '../../../shared/domain/skill'
import { redactCommonSecrets } from '../../security/redaction'
import { validateSkillMarkdown } from './skill-download-validator'
import { detectSkillScripts, SCRIPT_SKILL_REJECTION } from './skill-script-detector'
import { assertCanonicalContainment, ensureCanonicalDirectory } from '../../security/canonical-containment'

export const SOURCE_FILE = '.daweige-source.json'
const STAGING_MAX_AGE_MS = 24 * 60 * 60_000
// 含大写与下划线:按 pi 的 name 规则(^[a-z0-9-]+$)永不可能与任何合法技能名相等,
// 保证 probe 解析恒产生"恰好一条目录名不匹配"诊断(复核建议:防同名碰撞误拒)
const PROBE_SKILL_NAME = '_DAWEIGE_PROBE_'

type StagingWriteStage = 'probe-skill' | 'staged-skill' | 'source-record'

interface SkillInstallationStoreOptions {
  /** 仅供故障注入测试在每次落盘后模拟进程中断。 */
  readonly afterStagingWrite?: (stage: StagingWriteStage, stagingRoot: string) => void | Promise<void>
}

export interface SourceRecord {
  readonly schemaVersion: 1
  readonly provenance: Extract<SkillProvenance, { kind: 'market' | 'authored' }>
  readonly contentSha256: string
}

export interface PreparedSkill {
  readonly stagingRoot: string
  readonly stagingSkillDir: string
  readonly targetDir: string
  readonly name: string
  readonly markdown: string
  readonly contentSha256: string
  readonly provenance: Extract<SkillProvenance, { kind: 'market' | 'authored' }>
}

export type SourceRecordStatus =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly record: SourceRecord }

export class SkillInstallationStore {
  constructor(
    private readonly globalRoot: string,
    private readonly options: SkillInstallationStoreOptions = {},
  ) {}

  async prepare(input: {
    readonly markdown: string
    readonly expectedName?: string
    readonly provenance: Extract<SkillProvenance, { kind: 'market' | 'authored' }>
  }): Promise<PreparedSkill> {
    const markdown = validateSkillMarkdown(input.markdown)
    const redactedMarkdown = redactCommonSecrets(markdown)
    if (detectSkillScripts(redactedMarkdown).unsafe) throw new Error(SCRIPT_SKILL_REJECTION)
    const provenance = sanitizeProvenance(input.provenance)
    await this.ensureRoot()
    const stagingRoot = join(this.globalRoot, '.staging', randomUUID())
    let skillDir = ''
    try {
      await ensureCanonicalDirectory(this.trustedRoot(), stagingRoot)
      const parsedName = await this.parseSingleSkillName(stagingRoot, redactedMarkdown)
      if (input.expectedName && parsedName !== input.expectedName) {
        throw new Error('技能名称与目录名称不一致，本次没有安装。')
      }
      const redactedName = redactCommonSecrets(parsedName)
      if (redactedName !== parsedName) throw new Error('技能名称里疑似包含凭据，本次没有安装。')
      skillDir = join(stagingRoot, parsedName)
      await ensureCanonicalDirectory(this.trustedRoot(), skillDir)
      await this.writeStagingFile(
        join(skillDir, 'SKILL.md'), redactedMarkdown, 'staged-skill', stagingRoot,
      )
      await assertCanonicalContainment(this.trustedRoot(), skillDir)
      await validateStagedSkill(stagingRoot, parsedName)
      const contentSha256 = sha256(redactedMarkdown)
      const record: SourceRecord = { schemaVersion: 1, provenance, contentSha256 }
      await this.writeStagingFile(
        join(skillDir, SOURCE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'source-record', stagingRoot,
      )
      return {
        stagingRoot, stagingSkillDir: skillDir, targetDir: join(this.globalRoot, parsedName),
        name: parsedName, markdown: redactedMarkdown, contentSha256, provenance,
      }
    } catch (error) {
      await safeRemove(stagingRoot)
      throw error
    }
  }

  async install(prepared: PreparedSkill): Promise<void> {
    await this.verifyPrepared(prepared)
    try {
      await rename(prepared.stagingSkillDir, prepared.targetDir)
      await assertCanonicalContainment(this.trustedRoot(), prepared.targetDir)
      await safeRemove(prepared.stagingRoot)
    } catch (error) {
      await safeRemove(prepared.stagingRoot)
      throw error
    }
  }

  /** 用户批准后的 TOCTOU 复检；安装前还会再跑一次。 */
  async verifyPrepared(prepared: PreparedSkill): Promise<void> {
    await assertCanonicalContainment(this.trustedRoot(), prepared.stagingSkillDir)
    const current = await readFile(join(prepared.stagingSkillDir, 'SKILL.md'), 'utf8')
    if (sha256(current) !== prepared.contentSha256) throw new Error('安装预览后的技能内容发生变化，本次没有安装。')
    await assertMissing(prepared.targetDir)
    await assertCanonicalContainment(this.trustedRoot(), dirname(prepared.targetDir))
  }

  async discard(prepared: PreparedSkill): Promise<void> {
    await safeRemove(prepared.stagingRoot)
  }

  async cleanupStale(now = Date.now()): Promise<void> {
    const staging = join(this.globalRoot, '.staging')
    let names: string[]
    try {
      names = await readdir(staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const target = join(staging, name)
      try {
        const info = await lstat(target)
        if (!info.isSymbolicLink() && now - info.mtimeMs > STAGING_MAX_AGE_MS) await safeRemove(target)
      } catch {
        // 下次启动继续尝试；不把真实路径或远端内容写日志。
      }
    }
  }

  async readSourceRecord(skillDir: string): Promise<SourceRecord | undefined> {
    const status = await this.sourceRecordStatus(skillDir)
    return status.kind === 'valid' ? status.record : undefined
  }

  async sourceRecordStatus(skillDir: string): Promise<SourceRecordStatus> {
    try {
      const raw = await readFile(join(skillDir, SOURCE_FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<SourceRecord>
      if (
        !hasOnlyKeys(parsed as object, ['schemaVersion', 'provenance', 'contentSha256'])
        || parsed.schemaVersion !== 1
        || !/^[a-f0-9]{64}$/u.test(parsed.contentSha256 ?? '')
        || !isManagedProvenance(parsed.provenance)
      ) return { kind: 'invalid' }
      return { kind: 'valid', record: parsed as SourceRecord }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' }
    }
  }

  async verifyForUninstall(skillDir: string): Promise<{ record: SourceRecord; hasExtraFiles: boolean }> {
    await assertCanonicalContainment(this.trustedRoot(), skillDir)
    const record = await this.readSourceRecord(skillDir)
    if (!record) throw new Error('技能来源记录损坏，为避免误删已停止卸载。')
    const markdown = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    if (sha256(markdown) !== record.contentSha256) throw new Error('技能安装后已被修改，为避免误删已停止卸载。')
    const files = await readdir(skillDir)
    return { record, hasExtraFiles: files.some((file) => file !== 'SKILL.md' && file !== SOURCE_FILE) }
  }

  private async ensureRoot(): Promise<void> {
    await ensureCanonicalDirectory(this.trustedRoot(), join(this.globalRoot, '.staging'))
  }

  private async parseSingleSkillName(stagingRoot: string, markdown: string): Promise<string> {
    const probeDir = join(stagingRoot, PROBE_SKILL_NAME)
    await ensureCanonicalDirectory(this.trustedRoot(), probeDir)
    try {
      await this.writeStagingFile(
        join(probeDir, 'SKILL.md'), markdown, 'probe-skill', stagingRoot,
      )
      const loaded = await loadSkills(stagingRoot)
      if (loaded.skills.length !== 1) throw new Error('SKILL.md 缺少合法的 name，暂时不能安装。')
      const name = loaded.skills[0]?.skill.name
      const expectedMismatch = `name "${name}" does not match parent directory "${PROBE_SKILL_NAME}"`
      if (!name || loaded.diagnostics.length !== 1
        || loaded.diagnostics[0]?.code !== 'invalid_metadata'
        || loaded.diagnostics[0]?.message !== expectedMismatch) {
        throw new Error('SKILL.md 没有通过技能格式校验。')
      }
      return name
    } finally {
      await safeRemove(probeDir)
    }
  }

  private async writeStagingFile(
    path: string,
    content: string,
    stage: StagingWriteStage,
    stagingRoot: string,
  ): Promise<void> {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    await this.options.afterStagingWrite?.(stage, stagingRoot)
  }

  private trustedRoot(): string { return dirname(this.globalRoot) }
}

async function loadSkills(root: string) {
  const env = new NodeExecutionEnv({ cwd: root })
  try {
    return await loadSourcedSkills(env, [{ path: root, source: { kind: 'global' as const } }])
  } finally {
    await env.cleanup()
  }
}

async function validateStagedSkill(root: string, name: string): Promise<void> {
  const loaded = await loadSkills(root)
  if (loaded.diagnostics.length > 0 || loaded.skills.length !== 1) throw new Error('SKILL.md 没有通过技能格式校验。')
  if (loaded.skills[0]?.skill.name !== name) throw new Error('技能名称与目录名称不一致，本次没有安装。')
}

function isManagedProvenance(value: unknown): value is SourceRecord['provenance'] {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  const item = value as Record<string, unknown>
  if (item['kind'] === 'authored') return hasOnlyKeys(item, ['kind'])
  if (item['kind'] !== 'market') return false
  return hasOnlyKeys(item, ['kind', 'registryId', 'registryName', 'slug', 'owner', 'version', 'license', 'installedAt'])
    && (item['registryId'] === 'curated' || item['registryId'] === 'github')
    && boundedString(item['registryName'], 1, 120)
    && boundedString(item['slug'], 1, 200)
    && Number.isInteger(item['installedAt']) && (item['installedAt'] as number) >= 0
    && optionalString(item['owner'], 200)
    && optionalString(item['version'], 100)
    && optionalString(item['license'], 100)
}

function sanitizeProvenance(
  provenance: Extract<SkillProvenance, { kind: 'market' | 'authored' }>,
): Extract<SkillProvenance, { kind: 'market' | 'authored' }> {
  if (provenance.kind === 'authored') return { kind: 'authored' }
  return {
    ...provenance,
    registryName: redactCommonSecrets(provenance.registryName),
    slug: redactCommonSecrets(provenance.slug),
    ...(provenance.owner ? { owner: redactCommonSecrets(provenance.owner) } : {}),
    ...(provenance.version ? { version: redactCommonSecrets(provenance.version) } : {}),
    ...(provenance.license ? { license: redactCommonSecrets(provenance.license) } : {}),
  }
}

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || boundedString(value, 0, max)
}

function boundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && [...value].length >= min && [...value].length <= max
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const set = new Set(allowed)
  return Object.keys(value).every((key) => set.has(key))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path)
    throw new Error('同名技能已经存在，本次没有覆盖。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function safeRemove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 30 })
  } catch {
    // staging 清理失败不覆盖原业务错误；启动清理会再次处理。
  }
}

export { sha256 }
