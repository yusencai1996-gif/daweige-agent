import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoleTemplateId } from '../../shared/domain/role'
// 内容源是 default-skill-content.ts(gen:skills 从 defaults/**/*.md 生成),
// 不用 ?raw 导入——那是 Vite 专属语法,playwright 的 esbuild 不认。
import { DEFAULT_SKILL_CONTENT } from './default-skill-content'
import { daweigeRootForManagedPath, ensureCanonicalDirectory } from '../security/canonical-containment'

export interface DefaultSkillAsset {
  readonly name: string
  readonly content: string
}

const DEFAULT_ROLE_TEMPLATE_SKILLS: Partial<Record<RoleTemplateId, DefaultSkillAsset>> = {
  accountant: { name: 'multi-sheet-reconcile', content: DEFAULT_SKILL_CONTENT['accountant/multi-sheet-reconcile'] },
  writer: { name: 'work-report-writing', content: DEFAULT_SKILL_CONTENT['writer/work-report-writing'] },
  'file-steward': { name: 'files-and-photos-organize', content: DEFAULT_SKILL_CONTENT['file-steward/files-and-photos-organize'] },
  'manager-built-in': { name: 'delegation-breakdown', content: DEFAULT_SKILL_CONTENT['manager/delegation-breakdown'] },
}

export const DEFAULT_GLOBAL_SKILLS: readonly DefaultSkillAsset[] = [
  { name: 'skill-creator', content: DEFAULT_SKILL_CONTENT['global/skill-creator'] },
]

export function defaultSkillAsset(templateId: RoleTemplateId): DefaultSkillAsset | undefined {
  return DEFAULT_ROLE_TEMPLATE_SKILLS[templateId]
}

/** 全新环境 missing-only 补齐全局默认技能；升级判断由 migration 层负责。 */
export async function seedDefaultGlobalSkill(
  userDataPath: string,
  asset: DefaultSkillAsset,
): Promise<boolean> {
  const root = join(userDataPath, 'daweige', 'skills')
  const targetDir = join(root, asset.name)
  const target = join(targetDir, 'SKILL.md')
  await ensureCanonicalDirectory(join(userDataPath, 'daweige'), targetDir)
  try {
    await readFile(target)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await writeFile(target, asset.content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** missing-only：只补不存在的默认 SKILL.md，绝不覆盖用户修改。 */
export async function seedDefaultSkillIntoHome(
  homeDir: string,
  templateId: RoleTemplateId,
): Promise<boolean> {
  const asset = defaultSkillAsset(templateId)
  if (!asset) return false
  const targetDir = join(homeDir, 'extensions', 'skills', asset.name)
  const target = join(targetDir, 'SKILL.md')
  await ensureCanonicalDirectory(daweigeRootForManagedPath(homeDir), targetDir)
  try {
    await readFile(target)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await writeFile(target, asset.content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
