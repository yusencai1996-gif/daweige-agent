import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCatalogService } from '../../../src/main/skills/skill-catalog-service'
import { SkillInstallationStore } from '../../../src/main/skills/market/skill-installation-store'

let userData: string
beforeEach(async () => { userData = await mkdtemp(join(tmpdir(), 'skill-uninstall-')) })
afterEach(async () => { await rm(userData, { recursive: true, force: true }) })

describe('skill uninstall service', () => {
  it('generation+skillId 反查 market 全局技能并只把目标交给 trash', async () => {
    const catalog = new SkillCatalogService(userData, async () => [])
    const store = new SkillInstallationStore(catalog.globalSkillsRoot())
    const prepared = await store.prepare({
      markdown: '---\nname: removable\ndescription: ok\n---\nbody',
      provenance: { kind: 'market', registryId: 'curated', registryName: '精选目录', slug: 'removable', license: 'MIT', installedAt: 1 },
    })
    await store.install(prepared)
    const snapshot = await catalog.refresh()
    const skill = snapshot.skills.find((item) => item.name === 'removable')
    expect(skill?.canUninstall).toBe(true)
    const trashed: string[] = []
    const after = await catalog.uninstall(
      { skillId: skill?.id ?? '', expectedGeneration: snapshot.generation },
      async (path) => { trashed.push(path); await rm(path, { recursive: true }) },
    )
    expect(trashed).toEqual([join(catalog.globalSkillsRoot(), 'removable')])
    expect(after.skills.some((item) => item.name === 'removable')).toBe(false)
  })
})
