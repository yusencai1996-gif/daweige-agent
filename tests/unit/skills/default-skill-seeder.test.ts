import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedDefaultSkillIntoHome } from '../../../src/main/skills/default-skill-seeder'
import {
  DEFAULT_SKILL_060_SHA256,
  seedExistingDefaultSkills,
  WRITER_GUARDRAILS_060,
} from '../../../src/main/skills/default-skill-migration'
import { roleHomePath, stageRoleHome } from '../../../src/main/roles/role-files'
import { systemRoleHomePath } from '../../../src/main/roles/system-manager'
import { DEFAULT_SKILL_CONTENT } from '../../../src/main/skills/default-skill-content'
import { getTemplateDef } from '../../../src/main/roles/role-templates'
import { createHash } from 'node:crypto'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skill-seed-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('默认技能 seeder', () => {
  it('缺失时写入，已有时 missing-only 不覆盖', async () => {
    const roleId = 'agent-222222222222'
    const home = roleHomePath(dir, roleId)
    await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    const target = join(home, 'extensions', 'skills', 'work-report-writing', 'SKILL.md')
    expect(await readFile(target, 'utf8')).toContain('name: work-report-writing')
    await writeFile(target, '用户改过的内容', 'utf8')
    await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    expect(await readFile(target, 'utf8')).toBe('用户改过的内容')
  })

  it('stageRoleHome 按 templateId 种技能；notebook/legacy-empty 不种', async () => {
    const accountant = await stageRoleHome(dir, {
      schemaVersion: 1,
      roleId: 'agent-111111111111',
      templateId: 'accountant',
      personaSummary: '',
      capabilityTags: [],
    }, '')
    expect(await readFile(join(accountant, 'extensions', 'skills', 'multi-sheet-reconcile', 'SKILL.md'), 'utf8'))
      .toContain('name: multi-sheet-reconcile')
    const notebook = join(dir, 'notebook')
    expect(await seedDefaultSkillIntoHome(notebook, 'notebook')).toBe(false)
    expect(await seedDefaultSkillIntoHome(notebook, 'legacy-empty')).toBe(false)
  })

  it('小柊使用固定 system home 与 manager 默认技能', async () => {
    const home = systemRoleHomePath(dir)
    await seedExistingDefaultSkills(dir, [{ id: 'sys-xiaozhen', templateId: 'manager-built-in' }])
    const text = await readFile(join(home, 'extensions', 'skills', 'delegation-breakdown', 'SKILL.md'), 'utf8')
    expect(text).toContain('name: delegation-breakdown')
  })

  it('0.6.0 旧默认技能和旧 writer 守则升级到新版,二次运行幂等', async () => {
    const roleId = 'agent-333333333333'
    const home = roleHomePath(dir, roleId)
    await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    const skillPath = join(home, 'extensions', 'skills', 'work-report-writing', 'SKILL.md')
    const oldSkill = DEFAULT_SKILL_CONTENT['writer/work-report-writing'].replace(
      '- 给人看的成稿默认存 .docx;.md 只用于 agent 间交接或规则记录,不作为交付用户的成稿格式;文件名先给建议再存',
      '- 成稿默认存 .md,用户要 docx 再转;文件名先给建议再存',
    )
    expect(createHash('sha256').update(oldSkill).digest('hex')).toBe(DEFAULT_SKILL_060_SHA256.writer)
    await writeFile(skillPath, oldSkill, 'utf8')
    await writeFile(join(home, 'guardrails.md'), WRITER_GUARDRAILS_060, 'utf8')

    const first = await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    expect(first).toEqual({ scanned: 1, seeded: 0, upgraded: 1, guardrailsUpgraded: 1, preserved: 0, failed: 0 })
    expect(await readFile(skillPath, 'utf8')).toBe(DEFAULT_SKILL_CONTENT['writer/work-report-writing'])
    expect(await readFile(join(home, 'guardrails.md'), 'utf8')).toBe(getTemplateDef('writer')?.guardrailsDraft)

    const second = await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    expect(second).toEqual({ scanned: 1, seeded: 0, upgraded: 0, guardrailsUpgraded: 0, preserved: 0, failed: 0 })
  })

  it('新版技能不重写;用户改过的旧技能保留并给诊断,用户守则也保留', async () => {
    const currentRole = 'agent-444444444444'
    await seedExistingDefaultSkills(dir, [{ id: currentRole, templateId: 'writer' }])
    expect(await seedExistingDefaultSkills(dir, [{ id: currentRole, templateId: 'writer' }]))
      .toEqual({ scanned: 1, seeded: 0, upgraded: 0, guardrailsUpgraded: 0, preserved: 0, failed: 0 })

    const editedRole = 'agent-555555555555'
    const editedHome = roleHomePath(dir, editedRole)
    await seedExistingDefaultSkills(dir, [{ id: editedRole, templateId: 'writer' }])
    const target = join(editedHome, 'extensions', 'skills', 'work-report-writing', 'SKILL.md')
    await writeFile(target, '用户改过的技能', 'utf8')
    await writeFile(join(editedHome, 'guardrails.md'), '用户改过的守则', 'utf8')
    const diagnostics: string[] = []
    const result = await seedExistingDefaultSkills(
      dir,
      [{ id: editedRole, templateId: 'writer' }],
      (message) => diagnostics.push(message),
    )
    expect(result).toEqual({ scanned: 1, seeded: 0, upgraded: 0, guardrailsUpgraded: 0, preserved: 1, failed: 0 })
    expect(await readFile(target, 'utf8')).toBe('用户改过的技能')
    expect(await readFile(join(editedHome, 'guardrails.md'), 'utf8')).toBe('用户改过的守则')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('默认技能有新版,已保留你的修改'),
      expect.stringContaining('"status":"user-modified"'),
      expect.stringContaining('[skills:migration-summary]'),
    ]))
  })

  it('E-11 守则迁移诊断只含结构化状态/hash，不泄露正文或 key', async () => {
    const roleId = 'agent-666666666666'; const home = roleHomePath(dir, roleId)
    await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }])
    const secret = 'api_key=abcdefghijklmnopqrs'
    await writeFile(join(home, 'guardrails.md'), `用户守则 ${secret}`, 'utf8')
    const diagnostics: string[] = []
    await seedExistingDefaultSkills(dir, [{ id: roleId, templateId: 'writer' }], (message) => diagnostics.push(message))
    const text = diagnostics.join('\n')
    expect(text).toContain('"status":"user-modified"')
    expect(text).toMatch(/"expectedHash":"[a-f0-9]{8}"/)
    expect(text).toMatch(/"actualHash":"[a-f0-9]{8}"/)
    expect(text).not.toContain(secret)
    expect(text).not.toContain('用户守则')
  })

  it('E-12 allSettled 让中间角色失败不阻断前后项，失败计数正确且二次启动可补做', async () => {
    const roles = [
      { id: 'agent-777777777771', templateId: 'accountant' as const },
      { id: 'agent-777777777772', templateId: 'writer' as const },
      { id: 'agent-777777777773', templateId: 'file-steward' as const },
    ]
    const blocked = roleHomePath(dir, roles[1]!.id)
    await writeFile(blocked, '阻塞目录', { encoding: 'utf8', flag: 'wx' }).catch(async () => {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(dir, 'daweige', 'agents'), { recursive: true }))
      await writeFile(blocked, '阻塞目录', 'utf8')
    })
    const diagnostics: string[] = []
    const first = await seedExistingDefaultSkills(dir, roles, (message) => diagnostics.push(message))
    expect(first).toMatchObject({ scanned: 3, seeded: 2, failed: 1 })
    expect(await readFile(join(roleHomePath(dir, roles[0]!.id), 'extensions', 'skills', 'multi-sheet-reconcile', 'SKILL.md'), 'utf8')).toContain('name:')
    expect(await readFile(join(roleHomePath(dir, roles[2]!.id), 'extensions', 'skills', 'files-and-photos-organize', 'SKILL.md'), 'utf8')).toContain('name:')
    await rm(blocked, { force: true })
    const second = await seedExistingDefaultSkills(dir, [roles[1]!], (message) => diagnostics.push(message))
    expect(second).toMatchObject({ seeded: 1, failed: 0 })
  })
})
