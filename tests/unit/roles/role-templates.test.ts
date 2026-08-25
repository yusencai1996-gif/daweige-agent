import { describe, expect, it } from 'vitest'
import {
  LEGACY_EMPTY_GUARDRAILS,
  ROLE_TEMPLATES,
  buildProfile,
  getTemplateDef,
  listUserTemplates,
} from '../../../src/main/roles/role-templates'

describe('角色模板(PLAN §2.5)', () => {
  it('恰好四个用户模板,ID 与名称稳定', () => {
    expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual(['writer', 'accountant', 'file-steward', 'notebook'])
    expect(ROLE_TEMPLATES.map((t) => t.name)).toEqual(['写稿助手', '表格会计', '文件管家', '记事本'])
  })

  it('每个模板:守则草稿四段结构完整 + 人设摘要/标签非空', () => {
    for (const t of ROLE_TEMPLATES) {
      expect(t.guardrailsDraft).toMatch(/^# 角色守则/)
      expect(t.guardrailsDraft).toContain('## 身份')
      expect(t.guardrailsDraft).toContain('## 工作方式')
      expect(t.guardrailsDraft).toContain('## 不要做')
      expect(t.personaSummary.length).toBeGreaterThan(0)
      expect(t.capabilityTags.length).toBeGreaterThan(0)
      // 篇幅在推荐线内
      expect([...t.guardrailsDraft].length).toBeLessThanOrEqual(2000)
    }
  })

  it('listUserTemplates 不暴露 legacy-empty,草稿可预填', () => {
    const list = listUserTemplates()
    expect(list.map((t) => t.id)).not.toContain('legacy-empty')
    expect(list).toHaveLength(4)
    for (const t of list) {
      expect(t.guardrailsDraft.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it('legacy-empty:守则只有标题,人设空,不注入模板人格', () => {
    const def = getTemplateDef('legacy-empty')
    expect(def).toBeDefined()
    expect(def!.guardrailsDraft).toBe(LEGACY_EMPTY_GUARDRAILS)
    expect(def!.personaSummary).toBe('')
    expect(def!.capabilityTags).toEqual([])
  })

  it('buildProfile 写入 roleId/templateId 与模板人设', () => {
    const p = buildProfile('agent-a1b2c3d4e5f6', 'writer')
    expect(p.schemaVersion).toBe(1)
    expect(p.roleId).toBe('agent-a1b2c3d4e5f6')
    expect(p.templateId).toBe('writer')
    expect(p.personaSummary).toBe(ROLE_TEMPLATES[0]!.personaSummary)
  })
})
