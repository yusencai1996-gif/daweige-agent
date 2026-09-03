import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-agent-core'
import { createReadSkillTool } from '../../../src/main/agent/tools/read-skill'
import { SkillCatalogService, type SkillRoleTarget } from '../../../src/main/skills/skill-catalog-service'

const SKILL: Skill = {
  name: 'demo',
  description: 'demo description',
  content: '# Demo\n\n只把 scripts/run.js 当作文字说明，不执行。',
  filePath: 'daweige-skill://global/demo/SKILL.md',
}

async function execute(tool: ReturnType<typeof createReadSkillTool>, name: string) {
  return tool.execute('call-1', { name }, undefined, undefined)
}

describe('read_skill', () => {
  it('name 精确命中并用 pi formatter 返回正文和逻辑 URI', async () => {
    const result = await execute(createReadSkillTool({ skills: [SKILL] }), 'demo')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('# Demo')
    expect(text).toContain('daweige-skill://global/demo/SKILL.md')
  })

  it('找不到即失败，不回落文件读取', async () => {
    await expect(execute(createReadSkillTool({ skills: [SKILL] }), 'missing'))
      .rejects.toThrow('当前会话没有')
  })

  it('歧义即失败', async () => {
    await expect(execute(createReadSkillTool({ skills: [SKILL, { ...SKILL }] }), 'demo'))
      .rejects.toThrow('存在歧义')
  })

  it('含 scripts 的技能只返回 Markdown 正文，不暴露物理执行路径', async () => {
    const result = await execute(createReadSkillTool({ skills: [SKILL] }), 'demo')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('scripts/run.js')
    expect(text).not.toMatch(/[A-Z]:\\/i)
  })

  it('未命中参数与工具详情在返回边界再次打码', async () => {
    const secret = 'sk-123456789012345678901234'
    let message = ''
    try { await execute(createReadSkillTool({ skills: [SKILL] }), secret) } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('当前会话没有')
    expect(message).not.toContain(secret)
    const redactedSkill = { ...SKILL, name: 'sk-12***', filePath: 'daweige-skill://global/sk-12***/SKILL.md' }
    const result = await execute(createReadSkillTool({ skills: [redactedSkill] }), redactedSkill.name)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('generation 与会话冻结', () => {
  let dir: string
  const role: SkillRoleTarget = {
    roleId: 'agent-a1b2c3d4e5f6',
    roleDisplayName: '小编',
    templateId: 'writer',
  }
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skill-generation-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function put(root: string, name: string) {
    const target = join(root, name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}`, 'utf8')
  }

  it('refresh 后旧 SessionSkillContext 不变化，新上下文使用新 generation', async () => {
    const catalog = new SkillCatalogService(dir, async () => [role])
    await put(catalog.globalSkillsRoot(), 'old-skill')
    const oldContext = await catalog.sessionContext(role)
    await put(catalog.roleSkillsRoot(role.roleId), 'new-skill')
    await catalog.refresh()
    const newContext = await catalog.sessionContext(role)
    expect(oldContext.generation).toBe(1)
    expect(oldContext.promptFragment).not.toContain('new-skill')
    expect(newContext.generation).toBe(2)
    expect(newContext.promptFragment).toContain('new-skill')
  })

  it('internal worker 同样取得全局+自身角色技能', async () => {
    const catalog = new SkillCatalogService(dir, async () => [role])
    await put(catalog.globalSkillsRoot(), 'global-skill')
    await put(catalog.roleSkillsRoot(role.roleId), 'role-skill')
    const context = await catalog.sessionContext(role)
    expect(context.promptFragment).toContain('global-skill')
    expect(context.promptFragment).toContain('role-skill')
  })
})
