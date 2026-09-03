// 0.7.0 A3:技能行来源徽标 + 卸载入口可见性的静态标记断言。
// 行内二次确认的展开/焦点/Escape 由真实浏览器自检覆盖。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillRow, provenanceBadgeLabel } from '../../../src/renderer/features/settings/SkillPanel'
import type { InstalledSkill } from '../../../src/shared/domain'
import { MockBridge } from '../../helpers/mock-bridge'

const baseSkill: InstalledSkill = {
  id: 'global:demo',
  name: 'demo-skill',
  description: '演示技能',
  source: { kind: 'global' },
  builtIn: false,
  logicalLocation: 'daweige-skill://global/demo-skill/SKILL.md',
  provenance: { kind: 'manual' },
  canUninstall: false,
}

function renderRow(skill: InstalledSkill): string {
  const bridge = new MockBridge()
  return renderToStaticMarkup(
    createElement(SkillRow, {
      skill,
      generation: 1,
      bridge,
      onUninstalled: () => {},
    }),
  )
}

describe('SkillRow 来源徽标(0.7.0 A3)', () => {
  it('四种 provenance 的徽标文案', () => {
    expect(provenanceBadgeLabel({ ...baseSkill, builtIn: true, provenance: { kind: 'built-in' } })).toBe('内置')
    expect(provenanceBadgeLabel({ ...baseSkill, provenance: { kind: 'authored' } })).toBe('自创')
    expect(provenanceBadgeLabel({ ...baseSkill, provenance: { kind: 'manual' } })).toBe('自装')
    expect(
      provenanceBadgeLabel({
        ...baseSkill,
        provenance: {
          kind: 'market',
          registryId: 'curated',
          registryName: '内置精选',
          slug: 'demo-skill',
          installedAt: 1_000,
        },
      }),
    ).toBe('内置精选')
  })

  it('market + canUninstall:显示来源名徽标、元信息行与卸载按钮', () => {
    const html = renderRow({
      ...baseSkill,
      provenance: {
        kind: 'market',
        registryId: 'curated',
        registryName: '内置精选',
        slug: 'demo-skill',
        owner: 'daweige',
        version: '1.0.0',
        license: 'MIT',
        installedAt: 1_000,
      },
      canUninstall: true,
    })
    expect(html).toContain('内置精选')
    expect(html).toContain('作者 daweige')
    expect(html).toContain('版本 1.0.0')
    expect(html).toContain('许可 MIT')
    expect(html).toContain('卸载')
  })

  it('market 缺可选字段:元信息省略,不出现 undefined', () => {
    const html = renderRow({
      ...baseSkill,
      provenance: {
        kind: 'market',
        registryId: 'github',
        registryName: 'GitHub',
        slug: 'demo-skill',
        installedAt: 1_000,
      },
      canUninstall: true,
    })
    expect(html).toContain('GitHub')
    expect(html).not.toContain('undefined')
    expect(html).toContain('卸载')
  })

  it('authored + canUninstall:自创徽标 + 卸载按钮', () => {
    const html = renderRow({ ...baseSkill, provenance: { kind: 'authored' }, canUninstall: true })
    expect(html).toContain('自创')
    expect(html).toContain('卸载')
  })

  it('built-in/manual:无卸载按钮(内置与手工自管目录不由设置页删除)', () => {
    const builtInHtml = renderRow({ ...baseSkill, builtIn: true, provenance: { kind: 'built-in' } })
    expect(builtInHtml).toContain('内置')
    expect(builtInHtml).not.toContain('卸载')
    const manualHtml = renderRow({ ...baseSkill, provenance: { kind: 'manual' } })
    expect(manualHtml).toContain('自装')
    expect(manualHtml).not.toContain('卸载')
  })

  it('canUninstall=false 的 market 技能:徽标在,卸载按钮不在', () => {
    const html = renderRow({
      ...baseSkill,
      provenance: {
        kind: 'market',
        registryId: 'curated',
        registryName: '内置精选',
        slug: 'demo-skill',
        installedAt: 1_000,
      },
      canUninstall: false,
    })
    expect(html).toContain('内置精选')
    expect(html).not.toContain('卸载')
  })
})
