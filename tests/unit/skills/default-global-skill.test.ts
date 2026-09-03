import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SKILL_CONTENT } from '../../../src/main/skills/default-skill-content'
import {
  DEFAULT_GLOBAL_SKILL_HASH_MANIFEST,
  seedDefaultGlobalSkills,
} from '../../../src/main/skills/default-skill-migration'

let root: string
const target = () => join(root, 'daweige', 'skills', 'skill-creator', 'SKILL.md')
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'default-global-skill-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('全局默认 skill-creator', () => {
  it('源文件逐字等于统筹定稿，fresh/missing-only 自动补齐且 catalog manifest 对齐', async () => {
    const draft = await readFile(join(__dirname, '../../../.tmp-skill-creation-guide-draft.md'), 'utf8')
    expect(DEFAULT_SKILL_CONTENT['global/skill-creator']).toBe(draft)
    expect(await seedDefaultGlobalSkills(root)).toEqual({ seeded: 1, upgraded: 0, preserved: 0 })
    expect(await readFile(target(), 'utf8')).toBe(draft)
    expect(DEFAULT_GLOBAL_SKILL_HASH_MANIFEST['skill-creator']?.currentHash).toBe(sha256(draft))
    expect(await seedDefaultGlobalSkills(root)).toEqual({ seeded: 0, upgraded: 0, preserved: 0 })
  })

  it('上一官方 hash 原子升级，用户修改则保留并给无正文诊断', async () => {
    await seedDefaultGlobalSkills(root)
    const oldOfficial = DEFAULT_SKILL_CONTENT['global/skill-creator'].replace('# 技能创作指南', '# 旧版技能创作指南')
    await writeFile(target(), oldOfficial, 'utf8')
    const manifest = {
      'skill-creator': {
        currentHash: sha256(DEFAULT_SKILL_CONTENT['global/skill-creator']),
        previousHashes: [sha256(oldOfficial)],
      },
    }
    expect(await seedDefaultGlobalSkills(root, undefined, manifest))
      .toEqual({ seeded: 0, upgraded: 1, preserved: 0 })
    expect(await readFile(target(), 'utf8')).toBe(DEFAULT_SKILL_CONTENT['global/skill-creator'])

    await writeFile(target(), '用户自己的内容', 'utf8')
    const diagnostics: string[] = []
    expect(await seedDefaultGlobalSkills(root, (message) => diagnostics.push(message), manifest))
      .toEqual({ seeded: 0, upgraded: 0, preserved: 1 })
    expect(await readFile(target(), 'utf8')).toBe('用户自己的内容')
    expect(diagnostics).toEqual(['[skills] global:skill-creator:默认技能有新版,已保留你的修改'])
  })
})
