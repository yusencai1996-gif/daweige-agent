import type { RegistrySkillCandidate, RegistrySkillDetail, SkillRegistry } from './registry'
import { SkillRegistryError } from './registry'
import type { SkillRegistryHttpClient } from './skill-registry-http-client'
import { validateSearchInput, validateSkillMarkdown } from './skill-download-validator'

const PERMISSIVE_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC', 'CC0-1.0',
])
const COMMON_PATHS = ['SKILL.md', 'skills/SKILL.md', 'skill/SKILL.md'] as const
const CACHE_MS = 60_000

interface GitHubSearchResponse {
  readonly items?: readonly GitHubRepository[]
}

interface GitHubRepository {
  readonly full_name?: string
  readonly description?: string | null
  readonly stargazers_count?: number
  readonly default_branch?: string
  readonly license?: { readonly spdx_id?: string | null } | null
}

interface GitHubContentItem {
  readonly name?: string
  readonly path?: string
  readonly type?: string
}

interface CachedSearch {
  readonly at: number
  readonly candidates: readonly RegistrySkillCandidate[]
  filtered: number
}

export class GitHubRegistry implements SkillRegistry {
  readonly id = 'github' as const
  readonly displayName = 'GitHub'
  private readonly cache = new Map<string, CachedSearch>()
  private readonly repositories = new Map<string, GitHubRepository>()
  private filteredByLicense = 0

  constructor(private readonly http: SkillRegistryHttpClient) {}

  get lastFilteredByLicense(): number {
    return this.filteredByLicense
  }

  async search(input: { query: string; limit: number; signal: AbortSignal }): Promise<readonly RegistrySkillCandidate[]> {
    const { query, limit } = validateSearchInput(input.query, input.limit)
    if (input.signal.aborted) throw new SkillRegistryError('技能搜索已停止。')
    const cacheKey = `${query.toLocaleLowerCase()}\0${limit}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.at < CACHE_MS) {
      this.filteredByLicense = cached.filtered
      return cached.candidates
    }
    const url = new URL('https://api.github.com/search/repositories')
    url.searchParams.set('q', `${query} topic:agent-skills`)
    url.searchParams.set('per_page', String(limit))
    const payload = await this.http.getJson<GitHubSearchResponse>(url, input.signal)
    const items = Array.isArray(payload.items) ? payload.items : []
    this.filteredByLicense = 0
    const candidates: RegistrySkillCandidate[] = []
    for (const item of items) {
      const license = item.license?.spdx_id ?? undefined
      if (!license || !PERMISSIVE_LICENSES.has(license)) {
        this.filteredByLicense += 1
        continue
      }
      const slug = item.full_name?.trim()
      if (!slug || !validFullName(slug)) continue
      this.repositories.set(slug, item)
      candidates.push({
        registryId: 'github', slug, displayName: slug,
        summary: item.description?.trim() || '这个仓库没有填写简介。',
        owner: slug.split('/')[0], stars: Math.max(0, item.stargazers_count ?? 0),
        license, version: item.default_branch ?? 'main',
      })
    }
    candidates.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    const result = candidates.slice(0, limit)
    this.cache.set(cacheKey, { at: Date.now(), candidates: result, filtered: this.filteredByLicense })
    return result
  }

  async fetchSkill(input: { slug: string; signal: AbortSignal }): Promise<RegistrySkillDetail> {
    if (!validFullName(input.slug)) throw new SkillRegistryError('GitHub 技能标识不合法。')
    const repository = this.repositories.get(input.slug) ?? await this.fetchRepository(input.slug, input.signal)
    const license = repository.license?.spdx_id ?? undefined
    if (!license || !PERMISSIVE_LICENSES.has(license)) {
      throw new SkillRegistryError('这个仓库没有可确认的宽松许可证，本次不能安装。')
    }
    const ref = repository.default_branch?.trim() || 'main'
    const path = await this.findSkillPath(input.slug, ref, input.signal)
    // 纵深防御(后端专审建议):contents API 返回的 path 逐段白名单,防任何形态的段注入
    if (!path.split('/').every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== '..' && segment !== '.')) {
      throw new SkillRegistryError('这个仓库的技能文件路径不合法，本次不能安装。')
    }
    const [owner, repo] = input.slug.split('/') as [string, string]
    const raw = new URL(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`)
    const markdown = validateSkillMarkdown(await this.http.getMarkdown(raw, input.signal, 15_000))
    return {
      registryId: 'github', slug: input.slug, displayName: input.slug,
      summary: repository.description?.trim() || '这个仓库没有填写简介。', owner,
      stars: Math.max(0, repository.stargazers_count ?? 0), license, version: ref, markdown,
    }
  }

  private async fetchRepository(slug: string, signal: AbortSignal): Promise<GitHubRepository> {
    const url = new URL(`https://api.github.com/repos/${slug.split('/').map(encodeURIComponent).join('/')}`)
    const item = await this.http.getJson<GitHubRepository>(url, signal, 15_000)
    this.repositories.set(slug, item)
    return item
  }

  private async findSkillPath(slug: string, ref: string, signal: AbortSignal): Promise<string> {
    const [owner, repo] = slug.split('/') as [string, string]
    const rootUrl = contentsUrl(owner, repo, '', ref)
    const root = await this.http.getJson<readonly GitHubContentItem[]>(rootUrl, signal, 15_000)
    const rootSkill = root.find((item) => item.type === 'file' && item.name?.toLocaleLowerCase() === 'skill.md')
    if (rootSkill?.path === 'SKILL.md' || rootSkill?.path === 'skill.md') return rootSkill.path
    for (const directory of ['skills', 'skill'] as const) {
      const exists = root.some((item) => item.type === 'dir' && item.name?.toLocaleLowerCase() === directory)
      if (!exists) continue
      const children = await this.http.getJson<readonly GitHubContentItem[]>(contentsUrl(owner, repo, directory, ref), signal, 15_000)
      const skill = children.find((item) => item.type === 'file' && item.name?.toLocaleLowerCase() === 'skill.md')
      if (skill?.path && COMMON_PATHS.some((path) => path.toLocaleLowerCase() === skill.path?.toLocaleLowerCase())) return skill.path
    }
    throw new SkillRegistryError('这个仓库的常见位置里没有找到 SKILL.md。')
  }
}

function validFullName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
}

function contentsUrl(owner: string, repo: string, path: string, ref: string): URL {
  const suffix = path ? `/${encodeURIComponent(path)}` : ''
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${suffix}`)
  url.searchParams.set('ref', ref)
  return url
}

export { PERMISSIVE_LICENSES }
