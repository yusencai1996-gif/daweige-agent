export type SkillScope =
  | { readonly kind: 'global' }
  | {
      readonly kind: 'role'
      readonly roleId: string
      readonly roleDisplayName: string
    }

/** 技能市场来源由主进程固定注册；renderer 不接触 registry URL。 */
export type SkillRegistryId = 'curated' | 'github'

export type SkillProvenance =
  | { readonly kind: 'built-in' }
  | { readonly kind: 'authored' }
  | { readonly kind: 'manual' }
  | {
      readonly kind: 'market'
      readonly registryId: SkillRegistryId
      readonly registryName: string
      readonly slug: string
      readonly owner?: string
      readonly version?: string
      readonly license?: string
      readonly installedAt: number
    }

export interface InstalledSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: SkillScope
  readonly builtIn: boolean
  readonly logicalLocation: string
  readonly provenance: SkillProvenance
  readonly canUninstall: boolean
}

/** 市场候选只含展示字段；optionId 是主进程生成的短期 opaque id。 */
export interface SkillMarketCandidate {
  readonly optionId: string
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

export type SkillDiagnosticCode =
  | 'file_info_failed'
  | 'list_failed'
  | 'read_failed'
  | 'parse_failed'
  | 'invalid_metadata'
  | 'duplicate_name'
  | 'outside_root'
  | 'secret_redacted'

export interface SkillDiagnosticView {
  readonly code: SkillDiagnosticCode
  readonly message: string
  readonly source: SkillScope
  readonly relativePath?: string
}

export interface SkillListSnapshot {
  readonly generation: number
  readonly skills: readonly InstalledSkill[]
  readonly diagnostics: readonly SkillDiagnosticView[]
  readonly effectiveFrom: 'new-session'
}
