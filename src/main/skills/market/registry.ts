import type { SkillRegistryId } from '../../../shared/domain/skill'

export interface RegistrySkillCandidate {
  readonly registryId: SkillRegistryId
  readonly slug: string
  readonly displayName: string
  readonly summary: string
  readonly owner?: string
  readonly downloads?: number
  readonly installs?: number
  readonly stars?: number
  readonly version?: string
  readonly license?: string
}

export interface RegistrySkillDetail extends RegistrySkillCandidate {
  /** 仅含 SKILL.md 的 UTF-8 正文。 */
  readonly markdown: string
}

export interface SkillRegistry {
  readonly id: SkillRegistryId
  readonly displayName: string
  search(input: {
    readonly query: string
    readonly limit: number
    readonly signal: AbortSignal
  }): Promise<readonly RegistrySkillCandidate[]>
  fetchSkill(input: {
    readonly slug: string
    readonly signal: AbortSignal
  }): Promise<RegistrySkillDetail>
}

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillRegistryError'
  }
}
