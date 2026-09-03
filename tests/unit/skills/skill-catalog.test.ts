import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCatalogService, type SkillRoleTarget } from '../../../src/main/skills/skill-catalog-service'

let userData: string
const ROLE: SkillRoleTarget = {
  roleId: 'agent-a1b2c3d4e5f6',
  roleDisplayName: '账房',
  templateId: 'accountant',
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'skill-catalog-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function put(root: string, dir: string, name: string, description = '说明', body = '# 正文') {
  const target = join(root, dir)
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  )
}

function service(roles: readonly SkillRoleTarget[] = [ROLE]) {
  return new SkillCatalogService(userData, async () => roles)
}

describe('SkillCatalogService', () => {
  it('同时扫描 global + 当前 role，来源与内置标记正确', async () => {
    const catalog = service()
    await put(catalog.globalSkillsRoot(), 'shared', 'shared-skill')
    await put(catalog.roleSkillsRoot(ROLE.roleId), 'default', 'multi-sheet-reconcile')
    const snapshot = await catalog.list()
    expect(snapshot.skills.map((skill) => [skill.name, skill.source.kind])).toEqual([
      ['shared-skill', 'global'],
      ['multi-sheet-reconcile', 'role'],
    ])
    expect(snapshot.skills.find((skill) => skill.name === 'multi-sheet-reconcile')?.builtIn).toBe(true)
  })

  it('缺目录静默为空', async () => {
    await expect(service([]).list()).resolves.toMatchObject({ skills: [], diagnostics: [] })
  })

  it('合法 frontmatter 进入 pi XML 且 XML 特殊字符被转义', async () => {
    const catalog = service([])
    await put(catalog.globalSkillsRoot(), 'xml', 'xml-skill', '需要 <tag> & "quote"')
    const context = await catalog.sessionContext()
    expect(context.promptFragment).toContain('xml-skill')
    expect(context.promptFragment).not.toContain('<tag>')
    expect(context.promptFragment).toContain('&lt;tag&gt;')
    expect(context.promptFragment).toContain('&amp;')
  })

  it('缺 description、非法 name、坏 YAML 均由 pi 产生 diagnostics', async () => {
    const catalog = service([])
    const root = catalog.globalSkillsRoot()
    await mkdir(join(root, 'missing'), { recursive: true })
    await writeFile(join(root, 'missing', 'SKILL.md'), '---\nname: missing\n---\nbody', 'utf8')
    await mkdir(join(root, 'bad-name'), { recursive: true })
    await writeFile(join(root, 'bad-name', 'SKILL.md'), '---\nname: Bad Name\ndescription: x\n---\nbody', 'utf8')
    await mkdir(join(root, 'yaml'), { recursive: true })
    await writeFile(join(root, 'yaml', 'SKILL.md'), '---\nname: [\ndescription: x\n---\nbody', 'utf8')
    const snapshot = await catalog.list()
    expect(snapshot.diagnostics.length).toBeGreaterThanOrEqual(3)
    expect(snapshot.diagnostics.every((item) => item.source.kind === 'global')).toBe(true)
    expect(snapshot.diagnostics.some((item) => item.message.includes('缺少 description(技能说明)'))).toBe(true)
    expect(snapshot.diagnostics.some((item) => item.message.includes('SKILL.md 头部解析失败'))).toBe(true)
    expect(snapshot.diagnostics.every((item) => !/[a-z]+(?: [a-z]+){2,}/i.test(item.message.split('（英文原文：')[0] ?? ''))).toBe(true)
  })

  it('同层重名全部排除并给 duplicate_name', async () => {
    const catalog = service([])
    await put(catalog.globalSkillsRoot(), 'a', 'same')
    await put(catalog.globalSkillsRoot(), 'b', 'same')
    const snapshot = await catalog.list()
    expect(snapshot.skills).toHaveLength(0)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'duplicate_name' }))
  })

  it('角色同名覆盖全局', async () => {
    const catalog = service()
    await put(catalog.globalSkillsRoot(), 'global', 'same', 'global')
    await put(catalog.roleSkillsRoot(ROLE.roleId), 'role', 'same', 'role')
    const context = await catalog.sessionContext(ROLE)
    expect(context.promptFragment).toContain('role')
    expect(context.promptFragment).not.toContain('global')
  })

  it('symlink 越界技能不加载', async () => {
    const catalog = service([])
    const outside = join(userData, 'outside')
    await put(outside, 'escaped', 'escaped')
    await mkdir(catalog.globalSkillsRoot(), { recursive: true })
    await symlink(join(outside, 'escaped'), join(catalog.globalSkillsRoot(), 'linked'), 'junction')
    const snapshot = await catalog.list()
    expect(snapshot.skills).toHaveLength(0)
  })

  it('description/content 打码，UI 与 prompt 不含原 key', async () => {
    const catalog = service([])
    const secret = 'sk-123456789012345678901234'
    await put(catalog.globalSkillsRoot(), 'secret', 'secret-skill', `token=${secret}`, `正文 ${secret}`)
    const snapshot = await catalog.list()
    const context = await catalog.sessionContext()
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(context.promptFragment).not.toContain(secret)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'secret_redacted' }))
  })

  it('技能 name、logicalLocation、relativePath 与 read_skill 详情均不泄露 key 明文', async () => {
    const catalog = service([])
    const secret = 'sk-123456789012345678901234'
    await put(catalog.globalSkillsRoot(), secret, secret, '安全说明', '# 安全正文')
    const snapshot = await catalog.list()
    const context = await catalog.sessionContext()
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(context.promptFragment).not.toContain(secret)
    const displayName = snapshot.skills[0]?.name
    expect(displayName).toContain('***')
    const readTool = context.tools.find((tool) => tool.name === 'read_skill')
    if (!readTool || !displayName) throw new Error('read_skill 未创建')
    const result = await readTool.execute('call-1', { name: displayName }, undefined, undefined)
    expect(JSON.stringify(result)).not.toContain(secret)

    const invalidSecretDir = `${secret}-invalid`
    await put(catalog.globalSkillsRoot(), invalidSecretDir, 'different-name')
    const refreshed = await catalog.refresh()
    expect(JSON.stringify(refreshed.diagnostics)).not.toContain(secret)
    expect(refreshed.diagnostics.some((item) => item.relativePath?.includes('***'))).toBe(true)
  })

  it('对外只返回逻辑 URI，不返回 userData 绝对路径', async () => {
    const catalog = service([])
    await put(catalog.globalSkillsRoot(), 'safe', 'safe-skill')
    const snapshot = await catalog.list()
    expect(snapshot.skills[0]?.logicalLocation).toBe('daweige-skill://global/safe-skill/SKILL.md')
    expect(JSON.stringify(snapshot)).not.toContain(userData)
  })
})
