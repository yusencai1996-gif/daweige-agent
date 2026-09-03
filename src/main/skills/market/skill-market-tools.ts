import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import type { SkillMarketCandidate } from '../../../shared/domain/skill'
import type { ApprovalBroker } from '../../agent/approval-broker'
import { redactCommonSecrets } from '../../security/redaction'
import type { SkillCatalogService } from '../skill-catalog-service'
import type { SkillRegistryService } from './registry-service'
import type { SkillInstallationStore, PreparedSkill } from './skill-installation-store'
import type { SkillInstallTokenStore } from './skill-install-token-store'

const SearchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 120, description: '2 到 5 个英文名词，或用于精选目录的简短中文关键词' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
}, { additionalProperties: false })

const InstallParams = Type.Object({
  installToken: Type.String({ minLength: 16, maxLength: 128 }),
}, { additionalProperties: false })

export interface SkillMarketToolDeps {
  readonly sessionId: string
  readonly registry: SkillRegistryService
  readonly broker: ApprovalBroker
  readonly tokens: SkillInstallTokenStore
  readonly installations: SkillInstallationStore
  readonly catalog: SkillCatalogService
}

export function createSkillMarketTools(deps: SkillMarketToolDeps): AgentTool[] {
  return [createSearchSkillsTool(deps), createInstallSkillTool(deps)]
}

export function createSearchSkillsTool(deps: SkillMarketToolDeps): AgentTool<typeof SearchParams> {
  return {
    name: 'search_skills', label: '搜索技能',
    description: '从大微阁精选目录和 GitHub 安全候选中搜索技能。只传简短关键词，不传 URL；有候选时必须由用户亲自选择。',
    parameters: SearchParams, executionMode: 'sequential',
    execute: async (toolCallId, params: Static<typeof SearchParams>, signal?: AbortSignal) => {
      const activeSignal = signal ?? new AbortController().signal
      if (redactCommonSecrets(params.query) !== params.query) {
        throw new Error('搜索词里可能有密钥或敏感信息,已停止联网搜索;请换个说法描述要装的技能。')
      }
      const result = await deps.registry.search({ query: params.query, limit: params.limit ?? 5, signal: activeSignal })
      if (result.candidates.length === 0) {
        const notice = result.notices.map(redactCommonSecrets).join(' ')
        return textResult(`没有找到合适的技能。可以换 2～5 个更具体的英文名词再试。${notice ? ` ${notice}` : ''}`)
      }
      const internal = new Map(result.candidates.map((candidate) => [candidate.optionId, candidate]))
      const safeCandidates = result.candidates.map(sanitizeCandidate)
      const notice = result.notices.map(redactCommonSecrets).join(' ')
      const outcome = await deps.broker.requestSkillCandidate({
        sessionId: deps.sessionId, title: '请选择要查看的技能',
        description: `找到 ${safeCandidates.length} 个许可明确的候选。${notice}`.trim(),
        query: redactCommonSecrets(params.query), candidates: safeCandidates,
        toolCallId, signal: activeSignal,
      })
      if (outcome.decision !== 'approve' || !outcome.selectedOptionId) {
        const note = outcome.decision === 'reject' ? outcome.note?.trim() : undefined
        throw new Error(note ? `用户没有选择技能:${redactCommonSecrets(note)}` : '用户没有选择技能，本次不会安装。')
      }
      const selectedInternal = internal.get(outcome.selectedOptionId)
      const selectedSafe = safeCandidates.find((candidate) => candidate.optionId === outcome.selectedOptionId)
      if (!selectedInternal || !selectedSafe) throw new Error('候选选择已失效，请重新搜索。')
      const token = deps.tokens.issue(deps.sessionId, selectedSafe, selectedInternal.slug)
      return textResult([
        `已选择「${selectedSafe.displayName}」。`,
        `来源:${deps.registry.registryName(selectedSafe.registryId)}${selectedSafe.license ? `；许可:${selectedSafe.license}` : ''}。`,
        `如要安装，只能调用 install_skill，并原样传入 installToken=${token}。凭证十分钟内一次有效。`,
      ].join('\n'), { installToken: token, candidate: selectedSafe })
    },
  }
}

export function createInstallSkillTool(deps: SkillMarketToolDeps): AgentTool<typeof InstallParams> {
  return {
    name: 'install_skill', label: '安装技能',
    description: '使用 search_skills 返回的一次性 installToken 下载、检查并预览纯 Markdown 技能；用户批准后才安装。',
    parameters: InstallParams, executionMode: 'sequential',
    execute: async (toolCallId, params: Static<typeof InstallParams>, signal?: AbortSignal) => {
      const activeSignal = signal ?? new AbortController().signal
      const claim = deps.tokens.consume(params.installToken, deps.sessionId)
      let prepared: PreparedSkill | undefined
      try {
        const detail = await deps.registry.fetchSkill({
          registryId: claim.candidate.registryId, slug: claim.fetchSlug, signal: activeSignal,
        })
        if (claim.candidate.license && detail.license !== claim.candidate.license) {
          throw new Error('技能许可证在选择后发生变化，本次没有安装。')
        }
        prepared = await deps.installations.prepare({
          markdown: detail.markdown,
          provenance: {
            kind: 'market', registryId: claim.candidate.registryId,
            registryName: deps.registry.registryName(claim.candidate.registryId),
            slug: claim.fetchSlug,
            ...(detail.owner ? { owner: detail.owner } : {}),
            ...(detail.version ? { version: detail.version } : {}),
            ...(detail.license ? { license: detail.license } : {}),
            installedAt: Date.now(),
          },
        })
        const markdownBytes = Buffer.byteLength(prepared.markdown, 'utf8')
        const approved = await deps.broker.requestSkillInstall({
          sessionId: deps.sessionId, title: `安装技能「${redactCommonSecrets(prepared.name)}」`,
          description: '请检查完整 Markdown 内容、来源和许可；批准后会安装到全局技能目录。',
          candidate: { ...claim.candidate, displayName: redactCommonSecrets(prepared.name) },
          markdownPreview: prepared.markdown, markdownBytes, previewTruncated: false,
          targetLogicalLocation: `daweige-skill://global/${encodeURIComponent(prepared.name)}/SKILL.md`,
          toolCallId, signal: activeSignal,
        })
        if (approved.decision === 'reject') {
          await deps.installations.discard(prepared)
          prepared = undefined
          throw new Error(approved.note?.trim() ? `用户取消了技能安装:${redactCommonSecrets(approved.note)}` : '用户取消了技能安装，本次没有写入。')
        }
        deps.tokens.assertActive(claim, deps.sessionId)
        await deps.installations.install(prepared)
        prepared = undefined
        await deps.catalog.refresh()
        return textResult('已安装，新建对话后可用。')
      } finally {
        if (prepared) await deps.installations.discard(prepared)
        deps.tokens.finish(claim)
      }
    },
  }
}

function sanitizeCandidate(candidate: SkillMarketCandidate): SkillMarketCandidate {
  return {
    ...candidate,
    slug: clip(redactCommonSecrets(candidate.slug), 240),
    displayName: clip(redactCommonSecrets(candidate.displayName), 160),
    summary: clip(redactCommonSecrets(candidate.summary), 1_000),
    ...(candidate.owner ? { owner: clip(redactCommonSecrets(candidate.owner), 160) } : {}),
    ...(candidate.version ? { version: clip(redactCommonSecrets(candidate.version), 80) } : {}),
    ...(candidate.license ? { license: clip(redactCommonSecrets(candidate.license), 80) } : {}),
  }
}

function clip(value: string, max: number): string {
  return [...value].slice(0, max).join('')
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text: redactCommonSecrets(text) }], details }
}
