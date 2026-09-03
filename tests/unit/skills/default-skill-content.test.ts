import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SKILL_CONTENT } from '../../../src/main/skills/default-skill-content'

/**
 * 防漂移:default-skill-content.ts 是 defaults 目录下各技能 SKILL.md 的生成物(gen:skills)。
 * 改了 .md 忘记重新生成会导致生产内容与源文件不一致——本测试把漂移拦在 CI 之前。
 */

describe('默认技能内容生成物一致性', () => {
  const defaultsRoot = join(__dirname, '../../../src/main/skills/defaults')

  it('每份 .md 源与生成物逐字一致(改 .md 后必须跑 npm run gen:skills)', () => {
    const keys = Object.keys(DEFAULT_SKILL_CONTENT)
    expect(keys).toEqual([
      'accountant/multi-sheet-reconcile',
      'file-steward/files-and-photos-organize',
      'global/skill-creator',
      'manager/delegation-breakdown',
      'writer/work-report-writing',
    ])
    for (const key of keys) {
      const source = readFileSync(join(defaultsRoot, key, 'SKILL.md'), 'utf8')
      expect(DEFAULT_SKILL_CONTENT[key as keyof typeof DEFAULT_SKILL_CONTENT]).toBe(source)
    }
  })

  it('每份内容非空且含 frontmatter', () => {
    for (const content of Object.values(DEFAULT_SKILL_CONTENT)) {
      expect(content.length).toBeGreaterThan(50)
      expect(content.startsWith('---')).toBe(true)
    }
  })

  it('E-8 生成器产物无无效 eslint-disable，重复生成内容可保持逐字幂等', () => {
    const generated = readFileSync(join(__dirname, '../../../src/main/skills/default-skill-content.ts'), 'utf8')
    const generator = readFileSync(join(__dirname, '../../../scripts/gen-default-skills.mjs'), 'utf8')
    expect(generated).not.toContain('/* eslint-disable */')
    expect(generator).not.toContain("const eslint = '/* eslint-disable */")
    expect(generated).toContain('由 scripts/gen-default-skills.mjs 生成,勿手改')
  })
})
