import { createHash, randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RoleTemplateId } from '../../shared/domain/role'
import { getTemplateDef } from '../roles/role-templates'
import { readGuardrails, roleHomePath, writeGuardrails } from '../roles/role-files'
import { systemRoleHomePath } from '../roles/system-manager'
import {
  DEFAULT_GLOBAL_SKILLS,
  defaultSkillAsset,
  seedDefaultGlobalSkill,
  seedDefaultSkillIntoHome,
} from './default-skill-seeder'
import { assertCanonicalContainment, daweigeRootForManagedPath, ensureCanonicalDirectory } from '../security/canonical-containment'

/** 0.6.0 发布版四份默认技能的 SHA256；取证命令见 A-30 实施报告。 */
export const DEFAULT_SKILL_060_SHA256: Partial<Record<RoleTemplateId, string>> = {
  accountant: 'cc883fad85656449c9eda57976d90b462411e5248c1057f77f2d25a555f9f14a',
  'file-steward': 'fbab997b1a8e841573ffabdaebd87ad83ada21665c9832523e8dd85317146f62',
  'manager-built-in': 'e0c4ffe205b969815a475ad9e86eccfe808fc9572ecb35fe2938b07fa40651b0',
  writer: '2ca0b361def8889450046142dd5afab8fca36974c936dea67b6b1096d3d8745d',
}

/** 0.6.0 writer 模板生成的逐字守则；只用于识别未被用户修改的既有写稿角色。 */
export const WRITER_GUARDRAILS_060 = [
  '# 角色守则',
  '',
  '## 身份',
  '你是一位耐心的中文写稿助手,擅长把零散材料整理成清楚、自然的稿件。',
  '',
  '## 工作方式',
  '- 动笔前先确认题材、读者和篇幅;材料不够时先列缺口,不硬编。',
  '- 初稿完成后主动列出两三个可以再打磨的点,供用户挑选。',
  '- 用户提供的原话里如果有好句子,尽量保留原味。',
  '',
  '## 特别规矩',
  '- 成稿默认保存为 .md 或 .docx,按用户要求来;文件名先给建议。',
  '',
  '## 不要做',
  '- 不堆砌形容词,不用翻译腔,不写空话套话。',
  '- 不在稿子里编造没有出处的数字和事实。',
].join('\n')

export interface DefaultSkillMigrationResult {
  readonly scanned: number
  readonly seeded: number
  readonly upgraded: number
  readonly guardrailsUpgraded: number
  readonly preserved: number
  readonly failed: number
}

export interface DefaultGlobalSkillMigrationResult {
  readonly seeded: number
  readonly upgraded: number
  readonly preserved: number
}

/**
 * 全局默认 hash manifest。新技能首版没有 previousHashes，存量用户走 missing-only；
 * 后续改正文时把上一发布版 hash 加进 previousHashes 即可原子升级官方原文。
 */
export const DEFAULT_GLOBAL_SKILL_HASH_MANIFEST: Readonly<Record<string, {
  readonly currentHash: string
  readonly previousHashes: readonly string[]
}>> = Object.fromEntries(DEFAULT_GLOBAL_SKILLS.map((asset) => [asset.name, {
  currentHash: sha256(asset.content),
  previousHashes: [],
}]))

export async function seedDefaultGlobalSkills(
  userDataPath: string,
  diagnostic: (message: string) => void = (message) => console.warn(message),
  manifest: Readonly<Record<string, { readonly currentHash: string; readonly previousHashes: readonly string[] }>> = DEFAULT_GLOBAL_SKILL_HASH_MANIFEST,
): Promise<DefaultGlobalSkillMigrationResult> {
  const actions = await Promise.all(DEFAULT_GLOBAL_SKILLS.map(async (asset): Promise<SkillMigrationAction> => {
    if (await seedDefaultGlobalSkill(userDataPath, asset)) return 'seeded'
    const globalRoot = join(userDataPath, 'daweige', 'skills')
    const target = join(globalRoot, asset.name, 'SKILL.md')
    await assertCanonicalContainment(join(userDataPath, 'daweige'), target)
    const installed = await readFile(target, 'utf8')
    const installedHash = sha256(installed)
    const entry = manifest[asset.name]
    if (!entry || installedHash === entry.currentHash) return 'none'
    if (entry.previousHashes.includes(installedHash)) {
      await atomicWriteText(target, asset.content, join(userDataPath, 'daweige'))
      return 'upgraded'
    }
    diagnostic(`[skills] global:${asset.name}:默认技能有新版,已保留你的修改`)
    return 'preserved'
  }))
  return actions.reduce<DefaultGlobalSkillMigrationResult>((sum, action) => ({
    seeded: sum.seeded + Number(action === 'seeded'),
    upgraded: sum.upgraded + Number(action === 'upgraded'),
    preserved: sum.preserved + Number(action === 'preserved'),
  }), { seeded: 0, upgraded: 0, preserved: 0 })
}

/** 启动时幂等补齐既有角色；单个角色仍严格 missing-only。 */
export async function seedExistingDefaultSkills(
  userDataPath: string,
  roles: readonly { readonly id: string; readonly templateId: RoleTemplateId }[],
  diagnostic: (message: string) => void = (message) => console.warn(message),
): Promise<DefaultSkillMigrationResult> {
  const settled = await Promise.allSettled(roles.map(async (role) => {
    const home = role.templateId === 'manager-built-in'
      ? systemRoleHomePath(userDataPath)
      : roleHomePath(userDataPath, role.id)
    const skill = await migrateDefaultSkill(home, role.id, role.templateId, diagnostic)
    const guardrails = role.templateId === 'writer'
      ? await migrateWriterGuardrails(home, role.id, role.templateId, diagnostic)
      : 'current' as const
    return { role, skill, guardrails }
  }))
  const result = settled.reduce<DefaultSkillMigrationResult>((sum, item, index) => {
    if (item.status === 'rejected') {
      const role = roles[index]!
      migrationDiagnostic(diagnostic, {
        status: 'failed', roleId: role.id, template: role.templateId,
        expectedHash: shortHash(defaultSkillAsset(role.templateId)?.content),
        actualHash: 'unknown',
      })
      return { ...sum, failed: sum.failed + 1 }
    }
    return {
      ...sum,
      seeded: sum.seeded + Number(item.value.skill === 'seeded'),
      upgraded: sum.upgraded + Number(item.value.skill === 'upgraded'),
      guardrailsUpgraded: sum.guardrailsUpgraded + Number(item.value.guardrails === 'upgraded'),
      preserved: sum.preserved + Number(item.value.skill === 'preserved' || item.value.guardrails === 'user-modified'),
      failed: sum.failed + Number(item.value.guardrails === 'read-failed' || item.value.guardrails === 'write-failed'),
    }
  }, { scanned: roles.length, seeded: 0, upgraded: 0, guardrailsUpgraded: 0, preserved: 0, failed: 0 })
  diagnostic(`[skills:migration-summary] ${JSON.stringify(result)}`)
  return result
}

type SkillMigrationAction = 'none' | 'seeded' | 'upgraded' | 'preserved'

async function migrateDefaultSkill(
  home: string,
  roleId: string,
  templateId: RoleTemplateId,
  diagnostic: (message: string) => void,
): Promise<SkillMigrationAction> {
  const asset = defaultSkillAsset(templateId)
  if (!asset) return 'none'
  if (await seedDefaultSkillIntoHome(home, templateId)) return 'seeded'

  const oldHash = DEFAULT_SKILL_060_SHA256[templateId]
  if (oldHash === undefined) return 'none'
  const currentHash = sha256(asset.content)
  // 这份默认内容在 0.6.1 没变化；用户文件无论怎样都不需要“升级”提示。
  if (oldHash === currentHash) return 'none'

  const target = join(home, 'extensions', 'skills', asset.name, 'SKILL.md')
  const installed = await readFile(target, 'utf8')
  const installedHash = sha256(installed)
  if (installedHash === currentHash) return 'none'
  if (installedHash === oldHash) {
    await atomicWriteText(target, asset.content, daweigeRootForManagedPath(home))
    return 'upgraded'
  }
  diagnostic(`[skills] ${roleId}:默认技能有新版,已保留你的修改`)
  return 'preserved'
}

type GuardrailsMigrationStatus = 'missing' | 'current' | 'already-upgraded' | 'user-modified' | 'read-failed' | 'write-failed' | 'upgraded'

async function migrateWriterGuardrails(
  home: string,
  roleId: string,
  templateId: RoleTemplateId,
  diagnostic: (message: string) => void,
): Promise<GuardrailsMigrationStatus> {
  const current = getTemplateDef('writer')?.guardrailsDraft
  const expectedHash = shortHash(current)
  let installed: string
  try {
    installed = await readGuardrails(home)
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed'
    migrationDiagnostic(diagnostic, { status, roleId, template: templateId, expectedHash, actualHash: 'unknown' })
    return status
  }
  const actualHash = shortHash(installed)
  if (current === undefined || current === WRITER_GUARDRAILS_060) {
    migrationDiagnostic(diagnostic, { status: 'current', roleId, template: templateId, expectedHash, actualHash })
    return 'current'
  }
  if (installed === current) {
    migrationDiagnostic(diagnostic, { status: 'already-upgraded', roleId, template: templateId, expectedHash, actualHash })
    return 'already-upgraded'
  }
  if (installed !== WRITER_GUARDRAILS_060) {
    migrationDiagnostic(diagnostic, { status: 'user-modified', roleId, template: templateId, expectedHash, actualHash })
    return 'user-modified'
  }
  try {
    await writeGuardrails(home, current)
    return 'upgraded'
  } catch {
    migrationDiagnostic(diagnostic, { status: 'write-failed', roleId, template: templateId, expectedHash, actualHash })
    return 'write-failed'
  }
}

function migrationDiagnostic(
  diagnostic: (message: string) => void,
  fields: { status: Exclude<GuardrailsMigrationStatus, 'upgraded'> | 'failed'; roleId: string; template: RoleTemplateId; expectedHash: string; actualHash: string },
): void {
  diagnostic(`[skills:migration] ${JSON.stringify({
    status: fields.status,
    roleId: redactSafeField(fields.roleId),
    template: fields.template,
    expectedHash: fields.expectedHash,
    actualHash: fields.actualHash,
  })}`)
}

function shortHash(content: string | undefined): string { return content === undefined ? 'unknown' : sha256(content).slice(0, 8) }
function redactSafeField(value: string): string { return value.replace(/[^a-z0-9-]/giu, '?').slice(0, 64) }

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function atomicWriteText(target: string, content: string, trustedRoot: string): Promise<void> {
  await ensureCanonicalDirectory(trustedRoot, dirname(target))
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, target)
}
