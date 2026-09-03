import catalogJson from './curated/skills.json'
import type { RegistrySkillCandidate, RegistrySkillDetail, SkillRegistry } from './registry'
import { SkillRegistryError } from './registry'
import type { SkillRegistryHttpClient } from './skill-registry-http-client'
import { validateSearchInput, validateSkillMarkdown } from './skill-download-validator'

type CatalogEntry =
  | {
      readonly kind: 'builtin'
      readonly slug: string
      readonly displayName: string
      readonly summary: string
      readonly triggers: readonly string[]
      readonly tags: readonly string[]
      readonly owner: string
      readonly license: string
      readonly version?: string
      readonly markdown: string
    }
  | {
      readonly kind: 'remote'
      readonly slug: string
      readonly displayName: string
      readonly summary: string
      readonly triggers: readonly string[]
      readonly tags: readonly string[]
      readonly owner: string
      readonly repo: string
      readonly ref: string
      readonly path: string
      readonly license: string
      readonly version?: string
    }

const CATALOG = catalogJson as readonly CatalogEntry[]

export class CuratedCatalogRegistry implements SkillRegistry {
  readonly id = 'curated' as const
  readonly displayName = '精选目录'

  constructor(private readonly http: SkillRegistryHttpClient) {}

  async search(input: { query: string; limit: number; signal: AbortSignal }): Promise<readonly RegistrySkillCandidate[]> {
    const { query, limit } = validateSearchInput(input.query, input.limit)
    if (input.signal.aborted) throw new SkillRegistryError('技能搜索已停止。')
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    return CATALOG
      .map((entry) => ({ entry, score: matchScore(entry, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug))
      .slice(0, limit)
      .map(({ entry }) => candidateOf(entry))
  }

  async fetchSkill(input: { slug: string; signal: AbortSignal }): Promise<RegistrySkillDetail> {
    const entry = CATALOG.find((item) => item.slug === input.slug)
    if (!entry) throw new SkillRegistryError('精选目录里找不到这个技能。')
    const markdown = entry.kind === 'builtin'
      ? entry.markdown
      : await this.http.getMarkdown(rawUrl(entry), input.signal, 15_000)
    return { ...candidateOf(entry), markdown: validateSkillMarkdown(markdown) }
  }
}

function candidateOf(entry: CatalogEntry): RegistrySkillCandidate {
  return {
    registryId: 'curated', slug: entry.slug, displayName: entry.displayName,
    summary: entry.summary, owner: entry.owner, license: entry.license,
    ...(entry.version ? { version: entry.version } : {}),
  }
}

function matchScore(entry: CatalogEntry, terms: readonly string[]): number {
  const name = `${entry.slug} ${entry.displayName}`.toLocaleLowerCase()
  const tags = entry.tags.join(' ').toLocaleLowerCase()
  const text = `${entry.summary} ${entry.triggers.join(' ')}`.toLocaleLowerCase()
  return terms.reduce((score, term) => score + (name.includes(term) ? 5 : tags.includes(term) ? 3 : text.includes(term) ? 1 : 0), 0)
}

function rawUrl(entry: Extract<CatalogEntry, { kind: 'remote' }>): URL {
  for (const value of [entry.owner, entry.repo, entry.ref, ...entry.path.split('/')]) {
    if (!value || value === '.' || value === '..' || /[\\?#]/u.test(value)) {
      throw new SkillRegistryError('精选目录里的来源坐标不合法。')
    }
  }
  return new URL(`https://raw.githubusercontent.com/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.ref)}/${entry.path.split('/').map(encodeURIComponent).join('/')}`)
}
