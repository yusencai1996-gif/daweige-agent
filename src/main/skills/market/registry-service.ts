import { randomUUID } from 'node:crypto'
import type { SkillMarketCandidate, SkillRegistryId } from '../../../shared/domain/skill'
import type { RegistrySkillDetail, SkillRegistry } from './registry'
import { SkillRegistryError } from './registry'
import { validateSearchInput } from './skill-download-validator'

export interface RegistrySearchResult {
  readonly candidates: readonly SkillMarketCandidate[]
  readonly notices: readonly string[]
}

export class SkillRegistryService {
  private readonly byId: ReadonlyMap<SkillRegistryId, SkillRegistry>

  constructor(private readonly registries: readonly SkillRegistry[]) {
    this.byId = new Map(registries.map((registry) => [registry.id, registry]))
  }

  async search(input: { query: string; limit: number; signal: AbortSignal }): Promise<RegistrySearchResult> {
    const checked = validateSearchInput(input.query, input.limit)
    if (input.signal.aborted) throw new SkillRegistryError('技能搜索已停止。')
    const merged: SkillMarketCandidate[] = []
    const seen = new Set<string>()
    const notices: string[] = []
    for (const registry of this.registries) {
      if (merged.length >= checked.limit) break
      try {
        const found = await registry.search({ ...checked, limit: checked.limit - merged.length, signal: input.signal })
        for (const item of found) {
          const key = `${item.registryId}:${item.slug}`.toLocaleLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          merged.push({ optionId: randomUUID(), ...item })
        }
        if ('lastFilteredByLicense' in registry && typeof registry.lastFilteredByLicense === 'number' && registry.lastFilteredByLicense > 0) {
          notices.push(`${registry.lastFilteredByLicense} 条结果因许可证不明或不兼容已过滤。`)
        }
      } catch (error) {
        if (registry.id === 'curated' || input.signal.aborted) throw error
        notices.push(error instanceof SkillRegistryError ? error.message : 'GitHub 暂时无法搜索。')
      }
    }
    return { candidates: merged.slice(0, checked.limit), notices }
  }

  fetchSkill(input: { registryId: SkillRegistryId; slug: string; signal: AbortSignal }): Promise<RegistrySkillDetail> {
    const registry = this.byId.get(input.registryId)
    if (!registry) throw new SkillRegistryError('这个技能来源当前不可用。')
    return registry.fetchSkill({ slug: input.slug, signal: input.signal })
  }

  registryName(id: SkillRegistryId): string {
    return this.byId.get(id)?.displayName ?? id
  }
}
