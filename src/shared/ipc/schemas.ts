import { FormatRegistry, Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { ContractChannel, RequestOf } from './contracts'
import type { ApprovalRequest, ApprovalResponse } from '../domain/approval'

/**
 * 全部 IPC 入参的运行时 schema(M1-04)。
 * 安全前提:渲染进程不可信,主进程每个 handler 必须先过 validateRequest。
 */

const strict = { additionalProperties: false } as const

export const SKILL_MARKET_LIMITS = {
  optionId: 64,
  title: 120,
  description: 1_024, // 与 pi 0.84.4 MAX_DESCRIPTION_LENGTH 对齐(后端专审:装 1001~1024 长描述技能会死锁技能列表)
  query: 120,
  slug: 200,
  displayName: 200,
  summary: 1_000,
  owner: 200,
  version: 100,
  license: 100,
  markdownPreviewBytes: 64 * 1_024,
  contentPreviewBytes: 64 * 1_024,
  logicalLocation: 500,
} as const

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength
FormatRegistry.Set('daweige-skill-markdown-preview', (value) =>
  utf8ByteLength(value) <= SKILL_MARKET_LIMITS.markdownPreviewBytes)
FormatRegistry.Set('daweige-skill-content-preview', (value) =>
  utf8ByteLength(value) <= SKILL_MARKET_LIMITS.contentPreviewBytes)

const OpaqueOptionIdSchema = Type.String({
  minLength: 8,
  maxLength: SKILL_MARKET_LIMITS.optionId,
  pattern: '^[A-Za-z0-9_-]+$',
})

// ---------- 基础构件 ----------

const ProviderIdSchema = Type.Union([
  Type.Literal('kimi-coding'),
  Type.Literal('zai'),
  Type.Literal('zai-coding-cn'),
  Type.Literal('deepseek'),
])

const SessionIdSchema = Type.String({ minLength: 1, maxLength: 64 })

export const ProviderSelectionSchema = Type.Object(
  {
    providerId: ProviderIdSchema,
    modelId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  strict,
)

/** 角色 ID:agent- + 12 位小写十六进制。任意伪造格式(含 sys- 前缀)均被拒。 */
const RoleIdSchema = Type.String({ pattern: '^agent-[a-f0-9]{12}$' })

/** 会话挂靠的角色:普通 worker 或内置总管字面量(0.3.0);其余 sys-* 一律拒绝。 */
const SessionCreateRoleSchema = Type.Union([RoleIdSchema, Type.Literal('sys-xiaozhen')])

/** 派活运行 ID:run- + 16 位小写十六进制(主进程生成)。 */
const AgentRunIdSchema = Type.String({ pattern: '^run-[a-f0-9]{16}$' })

/** 角色显示名:1~24 字,首尾不允许空白(trim 由 schema 拒绝,主进程不再静默修剪)。 */
const RoleDisplayNameSchema = Type.String({
  minLength: 1,
  maxLength: 24,
  pattern: '^\\S(.*\\S)?$',
})

/** 守则正文:0~6000 Unicode 字符;24KiB UTF-8 字节上限由主进程二次校验(超长拒绝,不静默截断)。 */
const GuardrailsSchema = Type.String({ minLength: 0, maxLength: 6_000 })

/** 创建向导可选的人设模板;legacy-empty 仅迁移内部生成。 */
const RoleTemplateCreateSchema = Type.Union([
  Type.Literal('writer'),
  Type.Literal('accountant'),
  Type.Literal('file-steward'),
  Type.Literal('notebook'),
])

/**
 * Windows 绝对路径(盘符开头),拒绝相对路径与 .. 逃逸段。
 * 注意:这层只做字符串形状校验;完整路径策略(真实路径/Junction/大小写)在 M4-01。
 */
const AbsolutePathSchema = Type.String({
  minLength: 3,
  maxLength: 1000,
  pattern: '^[A-Za-z]:[\\\\/](?:[^\\\\/:*?"<>|\\r\\n]+[\\\\/])*[^\\\\/:*?"<>|\\r\\n]*$',
})

/** 路径中任何一段不能是 .. */
const NoDotDotSegment = Type.String({
  pattern: '^(?!.*(?:^|[\\\\/])\\.\\.([\\\\/]|$)).+$',
})

// ---------- 各通道请求 schema ----------

export const SessionCreateRequestSchema = Type.Object(
  {
    roleId: SessionCreateRoleSchema,
  },
  strict,
)

export const SessionOpenRequestSchema = Type.Object(
  { sessionId: SessionIdSchema },
  strict,
)

export const SessionRenameRequestSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    title: Type.String({ minLength: 1, maxLength: 60 }),
  },
  strict,
)

export const SessionDeleteRequestSchema = Type.Object(
  { sessionId: SessionIdSchema },
  strict,
)

export const SessionArchiveRequestSchema = Type.Object(
  { sessionId: SessionIdSchema },
  strict,
)

export const SessionRestoreRequestSchema = Type.Object(
  { sessionId: SessionIdSchema },
  strict,
)

// ---------- 派活(0.3.0)----------

export const AgentRunListRequestSchema = Type.Object(
  { managerSessionId: SessionIdSchema },
  strict,
)

export const AgentRunGetDetailRequestSchema = Type.Object(
  { runId: AgentRunIdSchema, managerSessionId: Type.String({ minLength: 1, maxLength: 128 }) },
  strict,
)

/** graph- + 16 位小写十六进制(0.4.0 D;主进程生成,入参只做形状校验,归属在 handler 层校验)。 */
export const AgentGraphIdSchema = Type.RegExp(/^graph-[a-f0-9]{16}$/, {
  message: '协作链编号不合法',
})

export const AgentRunGetGraphRequestSchema = Type.Object(
  { graphId: AgentGraphIdSchema, managerSessionId: SessionIdSchema },
  strict,
)

export const AgentRunInterruptRequestSchema = Type.Object(
  { runId: AgentRunIdSchema, managerSessionId: SessionIdSchema },
  strict,
)

// ---------- 角色(0.2.0)----------

const RoleGetRequestSchema = Type.Object({ roleId: RoleIdSchema }, strict)

export const RoleCreateRequestSchema = Type.Object(
  {
    displayName: RoleDisplayNameSchema,
    workspacePaths: Type.Array(Type.Intersect([AbsolutePathSchema, NoDotDotSegment]), {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
    primaryWorkspacePath: Type.Intersect([AbsolutePathSchema, NoDotDotSegment]),
    templateId: RoleTemplateCreateSchema,
    guardrails: GuardrailsSchema,
  },
  strict,
)

export const RoleUpdateRequestSchema = Type.Object(
  {
    roleId: RoleIdSchema,
    displayName: RoleDisplayNameSchema,
  },
  strict,
)

export const RoleUpdateGuardrailsRequestSchema = Type.Object(
  {
    roleId: RoleIdSchema,
    guardrails: GuardrailsSchema,
    expectedVersion: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  },
  strict,
)

export const RoleArchiveRequestSchema = RoleGetRequestSchema

export const RoleRestoreRequestSchema = RoleGetRequestSchema

export const RoleGetDeleteImpactRequestSchema = RoleGetRequestSchema

export const RoleDeleteRequestSchema = Type.Object(
  {
    roleId: RoleIdSchema,
    confirmDisplayName: RoleDisplayNameSchema,
    impactVersion: Type.String({ minLength: 8, maxLength: 128 }),
    /** 语义唯一:连同子会话与角色家目录一起删;只接受字面 true。 */
    deleteSessions: Type.Literal(true),
  },
  strict,
)

export const MessageSendRequestSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    selection: ProviderSelectionSchema,
  },
  strict,
)

export const MessageAbortRequestSchema = Type.Object(
  { sessionId: SessionIdSchema },
  strict,
)

export const ApprovalRespondRequestSchema = Type.Object(
  {
    approvalId: Type.String({ minLength: 8, maxLength: 128 }),
    decision: Type.Union([
      Type.Literal('approve'),
      Type.Literal('approve-session'),
      Type.Literal('reject'),
    ]),
    selectedOptionId: Type.Optional(OpaqueOptionIdSchema),
    note: Type.Optional(Type.String({ maxLength: 200 })),
  },
  strict,
)

export const WindowBoundsSchema = Type.Object(
  {
    width: Type.Number({ minimum: 400, maximum: 8192 }),
    height: Type.Number({ minimum: 300, maximum: 8192 }),
    x: Type.Optional(Type.Number({ minimum: -8192, maximum: 8192 })),
    y: Type.Optional(Type.Number({ minimum: -8192, maximum: 8192 })),
    maximized: Type.Boolean(),
  },
  strict,
)

export const SettingsSchema = Type.Object(
  {
    providerSelection: ProviderSelectionSchema,
    enabledModels: Type.Optional(Type.Array(ProviderSelectionSchema, { maxItems: 32, uniqueItems: true })),
    roleModelDefaults: Type.Optional(
      Type.Record(
        Type.String({ pattern: '^(?:agent-[a-f0-9]{12}|sys-xiaozhen)$' }),
        ProviderSelectionSchema,
        { maxProperties: 128 },
      ),
    ),
    windowBounds: Type.Optional(WindowBoundsSchema),
    lastActiveSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    thinkingLevel: Type.Optional(
      Type.Union([Type.Literal('off'), Type.Literal('low'), Type.Literal('high')]),
    ),
    managerWorkspacePath: Type.Optional(
      Type.String({ minLength: 2, maxLength: 1024 }),
    ),
  },
  strict,
)

export const SettingsUpdateRequestSchema = Type.Object(
  { settings: SettingsSchema },
  strict,
)

export const ManagerWorkspaceStateSchema = Type.Object(
  {
    effectivePath: Type.String({ minLength: 2, maxLength: 1024 }),
    isDefault: Type.Boolean(),
    restartRequired: Type.Boolean(),
    cleanupWarning: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
)

export const ManagerWorkspaceMigrateRequestSchema = Type.Object(
  {
    targetPath: Type.String({ minLength: 2, maxLength: 1024 }),
  },
  strict,
)

export const CredentialSaveRequestSchema = Type.Object(
  {
    providerId: ProviderIdSchema,
    apiKey: Type.String({ minLength: 8, maxLength: 512 }),
  },
  strict,
)

export const CredentialDeleteRequestSchema = Type.Object(
  { providerId: ProviderIdSchema },
  strict,
)

export const CredentialTestRequestSchema = Type.Object(
  { providerId: ProviderIdSchema },
  strict,
)

export const CredentialListModelsRequestSchema = Type.Object(
  { providerId: ProviderIdSchema },
  strict,
)

export const WorkspaceImportFilesRequestSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
  },
  strict,
)

export const SkillOpenFolderRequestSchema = Type.Union([
  Type.Object({ scope: Type.Literal('global') }, strict),
  Type.Object(
    {
      scope: Type.Literal('role'),
      roleId: Type.String({ pattern: '^(?:agent-[0-9a-f]{12}|sys-xiaozhen)$' }),
    },
    strict,
  ),
])

export const SkillUninstallRequestSchema = Type.Object(
  {
    skillId: Type.String({ minLength: 1, maxLength: 200 }),
    expectedGeneration: Type.Integer({ minimum: 0 }),
  },
  strict,
)

export const MemoryListPageRequestSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  strict,
)

export const MemoryIdSchema = Type.String({
  minLength: 24,
  maxLength: 128,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]{0,79}\\.md$',
})

export const MemoryDeleteRequestSchema = Type.Object(
  {
    memoryId: MemoryIdSchema,
  },
  strict,
)

// ---------- Gate 1 响应 schema ----------

const SkillScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('global') }, strict),
  Type.Object(
    {
      kind: Type.Literal('role'),
      roleId: Type.String(),
      roleDisplayName: Type.String(),
    },
    strict,
  ),
])

export const SkillRegistryIdSchema = Type.Union([
  Type.Literal('curated'),
  Type.Literal('github'),
])

export const SkillProvenanceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('built-in') }, strict),
  Type.Object({ kind: Type.Literal('authored') }, strict),
  Type.Object({ kind: Type.Literal('manual') }, strict),
  Type.Object(
    {
      kind: Type.Literal('market'),
      registryId: SkillRegistryIdSchema,
      registryName: Type.String({ minLength: 1, maxLength: 120 }),
      slug: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.slug }),
      owner: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.owner })),
      version: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.version })),
      license: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.license })),
      installedAt: Type.Integer({ minimum: 0 }),
    },
    strict,
  ),
])

export const SkillMarketCandidateSchema = Type.Object(
  {
    optionId: OpaqueOptionIdSchema,
    registryId: SkillRegistryIdSchema,
    slug: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.slug }),
    displayName: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.displayName }),
    summary: Type.String({ maxLength: SKILL_MARKET_LIMITS.summary }),
    owner: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.owner })),
    downloads: Type.Optional(Type.Integer({ minimum: 0 })),
    installs: Type.Optional(Type.Integer({ minimum: 0 })),
    stars: Type.Optional(Type.Integer({ minimum: 0 })),
    version: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.version })),
    license: Type.Optional(Type.String({ maxLength: SKILL_MARKET_LIMITS.license })),
  },
  strict,
)

export const SkillCandidateApprovalRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 8, maxLength: 128 }),
    kind: Type.Literal('skill-candidate'),
    title: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.title }),
    description: Type.String({ maxLength: SKILL_MARKET_LIMITS.description }),
    query: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.query }),
    candidates: Type.Array(SkillMarketCandidateSchema, { minItems: 1, maxItems: 8 }),
    createdAt: Type.Integer({ minimum: 0 }),
    toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  strict,
)

export const SkillInstallApprovalRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 8, maxLength: 128 }),
    kind: Type.Literal('skill-install'),
    title: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.title }),
    description: Type.String({ maxLength: SKILL_MARKET_LIMITS.description }),
    candidate: SkillMarketCandidateSchema,
    markdownPreview: Type.String({
      format: 'daweige-skill-markdown-preview',
      maxLength: SKILL_MARKET_LIMITS.markdownPreviewBytes,
    }),
    markdownBytes: Type.Integer({ minimum: 0, maximum: SKILL_MARKET_LIMITS.markdownPreviewBytes }),
    previewTruncated: Type.Boolean(),
    targetLogicalLocation: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.logicalLocation }),
    createdAt: Type.Integer({ minimum: 0 }),
    toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  strict,
)

export const FileApprovalRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 8, maxLength: 128 }),
    kind: Type.Union([
      Type.Literal('write'),
      Type.Literal('edit'),
      Type.Literal('move'),
      Type.Literal('rename'),
      Type.Literal('delete'),
      Type.Literal('mkdir'),
      Type.Literal('outside-read'),
      Type.Literal('role-rules-edit'),
    ]),
    title: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.title }),
    description: Type.String({ maxLength: SKILL_MARKET_LIMITS.description }),
    itemCount: Type.Integer({ minimum: 0 }),
    samplePaths: Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 5 }),
    recoverable: Type.Boolean(),
    outsideWorkspace: Type.Boolean(),
    toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    toolName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    createdAt: Type.Integer({ minimum: 0 }),
    contentPreview: Type.Optional(Type.String({
      format: 'daweige-skill-content-preview',
      maxLength: SKILL_MARKET_LIMITS.contentPreviewBytes,
    })),
  },
  strict,
)

const InstalledSkillSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    description: Type.String({ maxLength: SKILL_MARKET_LIMITS.description }),
    source: SkillScopeSchema,
    builtIn: Type.Boolean(),
    logicalLocation: Type.String({ minLength: 1, maxLength: SKILL_MARKET_LIMITS.logicalLocation }),
    provenance: SkillProvenanceSchema,
    canUninstall: Type.Boolean(),
  },
  strict,
)

const SkillDiagnosticCodeSchema = Type.Union([
  Type.Literal('file_info_failed'),
  Type.Literal('list_failed'),
  Type.Literal('read_failed'),
  Type.Literal('parse_failed'),
  Type.Literal('invalid_metadata'),
  Type.Literal('duplicate_name'),
  Type.Literal('outside_root'),
  Type.Literal('secret_redacted'),
])

const SkillDiagnosticViewSchema = Type.Object(
  {
    code: SkillDiagnosticCodeSchema,
    message: Type.String(),
    source: SkillScopeSchema,
    relativePath: Type.Optional(Type.String()),
  },
  strict,
)

export const SkillListSnapshotSchema = Type.Object(
  {
    generation: Type.Integer({ minimum: 0 }),
    skills: Type.Array(InstalledSkillSchema),
    diagnostics: Type.Array(SkillDiagnosticViewSchema),
    effectiveFrom: Type.Literal('new-session'),
  },
  strict,
)

const MemoryDateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('recurring'),
      month: Type.Integer({ minimum: 1, maximum: 12 }),
      day: Type.Integer({ minimum: 1, maximum: 31 }),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal('fixed'),
      iso: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    },
    strict,
  ),
])

const MemorySourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('conversation'),
      roleId: Type.Union([Type.String(), Type.Null()]),
      roleDisplayName: Type.String(),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal('life-note-migration'),
      legacyId: Type.String(),
    },
    strict,
  ),
])

const MemoryNoteSummarySchema = Type.Object(
  {
    id: MemoryIdSchema,
    content: Type.String(),
    createdAt: Type.Number(),
    source: MemorySourceSchema,
    title: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
    date: Type.Optional(MemoryDateSchema),
  },
  strict,
)

const MemoryMergeStateSchema = Type.Union([
  Type.Literal('clean'),
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('failed'),
])

export const MemoryListPageSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    mergeState: MemoryMergeStateSchema,
    entries: Type.Array(MemoryNoteSummarySchema),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    total: Type.Integer({ minimum: 0 }),
    reset: Type.Boolean(),
  },
  strict,
)

export const MemoryDeleteResponseSchema = Type.Object(
  {
    deleted: Type.Boolean(),
    revision: Type.Integer({ minimum: 0 }),
    mergeState: MemoryMergeStateSchema,
  },
  strict,
)

export const MemoryClearResponseSchema = Type.Object(
  {
    deletedCount: Type.Integer({ minimum: 0 }),
    revision: Type.Integer({ minimum: 0 }),
    mergeState: MemoryMergeStateSchema,
  },
  strict,
)

export const VoidResponseSchema = Type.Void()

// ---------- 通道 → schema 映射 ----------

/** 有实际入参的通道才登记 schema;request 为 void 的通道无需校验。 */
export const REQUEST_SCHEMAS: Readonly<Partial<Record<ContractChannel, TSchema>>> = {
  'role:get': RoleGetRequestSchema,
  'role:create': RoleCreateRequestSchema,
  'role:update': RoleUpdateRequestSchema,
  'role:updateGuardrails': RoleUpdateGuardrailsRequestSchema,
  'role:archive': RoleArchiveRequestSchema,
  'role:restore': RoleRestoreRequestSchema,
  'role:getDeleteImpact': RoleGetDeleteImpactRequestSchema,
  'role:delete': RoleDeleteRequestSchema,
  'session:create': SessionCreateRequestSchema,
  'session:open': SessionOpenRequestSchema,
  'session:rename': SessionRenameRequestSchema,
  'session:delete': SessionDeleteRequestSchema,
  'session:archive': SessionArchiveRequestSchema,
  'session:restore': SessionRestoreRequestSchema,
  'agentRun:list': AgentRunListRequestSchema,
  'agentRun:getDetail': AgentRunGetDetailRequestSchema,
  'agentRun:getGraph': AgentRunGetGraphRequestSchema,
  'agentRun:interrupt': AgentRunInterruptRequestSchema,
  'message:send': MessageSendRequestSchema,
  'message:abort': MessageAbortRequestSchema,
  'approval:respond': ApprovalRespondRequestSchema,
  'settings:update': SettingsUpdateRequestSchema,
  'managerWorkspace:migrate': ManagerWorkspaceMigrateRequestSchema,
  'credential:save': CredentialSaveRequestSchema,
  'credential:delete': CredentialDeleteRequestSchema,
  'credential:test': CredentialTestRequestSchema,
  'credential:listModels': CredentialListModelsRequestSchema,
  'workspace:importFiles': WorkspaceImportFilesRequestSchema,
  'skill:openFolder': SkillOpenFolderRequestSchema,
  'skill:uninstall': SkillUninstallRequestSchema,
  'memory:list': MemoryListPageRequestSchema,
  'memory:delete': MemoryDeleteRequestSchema,
}

/** Gate 1 新增通道的响应 schema；供契约测试和后续主进程响应校验复用。 */
export const RESPONSE_SCHEMAS: Readonly<Partial<Record<ContractChannel, TSchema>>> = {
  'skill:list': SkillListSnapshotSchema,
  'skill:refresh': SkillListSnapshotSchema,
  'skill:uninstall': SkillListSnapshotSchema,
  'skill:openFolder': VoidResponseSchema,
  'memory:list': MemoryListPageSchema,
  'memory:delete': MemoryDeleteResponseSchema,
  'memory:clear': MemoryClearResponseSchema,
}

export type RequestValidationResult<C extends ContractChannel> =
  | { ok: true; value: RequestOf<C> }
  | { ok: false; message: string }

/**
 * 主进程 handler 入口统一调用:未知通道/入参不合法直接拒绝。
 * message 为中文,可直接进 IpcErrorPayload。
 */
export function validateRequest<C extends ContractChannel>(
  channel: C,
  payload: unknown,
): RequestValidationResult<C> {
  const schema: TSchema | undefined = REQUEST_SCHEMAS[channel]
  if (!schema) {
    // 契约中该通道无入参 schema:只接受 undefined/null
    if (payload !== undefined && payload !== null) {
      return { ok: false, message: `通道 ${channel} 不接受任何参数` }
    }
    return { ok: true, value: undefined as RequestOf<C> }
  }
  if (!Value.Check(schema, payload)) {
    const errors = [...Value.Errors(schema, payload)]
      .slice(0, 3)
      .map((e) => `${e.path || '(根)'}: ${e.message}`)
      .join(';')
    return { ok: false, message: `参数不合法:${errors}` }
  }
  return { ok: true, value: payload as RequestOf<C> }
}

export type ResponseValidationResult<C extends ContractChannel> =
  | { ok: true; value: import('./contracts').ResponseOf<C> }
  | { ok: false; message: string }

/** preload 在把主进程结果交给 renderer 前，对已冻结的响应做第二次边界校验。 */
export function validateResponse<C extends ContractChannel>(
  channel: C,
  payload: unknown,
): ResponseValidationResult<C> {
  const schema: TSchema | undefined = RESPONSE_SCHEMAS[channel]
  if (!schema) return { ok: true, value: payload as import('./contracts').ResponseOf<C> }
  if (!Value.Check(schema, payload)) {
    return { ok: false, message: `通道 ${channel} 返回了不合法的数据` }
  }
  if (
    (channel === 'skill:list' || channel === 'skill:refresh' || channel === 'skill:uninstall')
    && !hasValidSkillUninstallSemantics(payload as Static<typeof SkillListSnapshotSchema>)
  ) {
    return { ok: false, message: `通道 ${channel} 返回了不合法的技能卸载权限` }
  }
  return { ok: true, value: payload as import('./contracts').ResponseOf<C> }
}

function hasValidSkillUninstallSemantics(snapshot: Static<typeof SkillListSnapshotSchema>): boolean {
  return snapshot.skills.every((skill) => {
    if (!skill.canUninstall) return true
    return skill.source.kind === 'global'
      && skill.builtIn === false
      && (skill.provenance.kind === 'market' || skill.provenance.kind === 'authored')
  })
}

/**
 * 技能审批的跨字段语义校验位。broker 下一批调用；本批先冻结 fail-closed 规则。
 */
export function validateApprovalResponseForRequest(
  request: ApprovalRequest,
  response: unknown,
): response is ApprovalResponse {
  if (!Value.Check(ApprovalRespondRequestSchema, response)) return false
  const checked = response as ApprovalResponse
  if (request.kind === 'skill-candidate') {
    if (checked.decision === 'approve-session') return false
    if (checked.decision === 'approve') {
      return checked.selectedOptionId !== undefined
        && request.candidates.some((candidate) => candidate.optionId === checked.selectedOptionId)
    }
    return checked.selectedOptionId === undefined
  }
  if (request.kind === 'skill-install') {
    return checked.decision !== 'approve-session' && checked.selectedOptionId === undefined
  }
  return checked.selectedOptionId === undefined
}

export function isValidSkillApprovalRequest(
  request: unknown,
): request is import('../domain/approval').SkillCandidateApprovalRequest
  | import('../domain/approval').SkillInstallApprovalRequest {
  if (typeof request !== 'object' || request === null || !('kind' in request)) return false
  if (request.kind === 'skill-candidate') {
    return Value.Check(SkillCandidateApprovalRequestSchema, request)
  }
  if (request.kind === 'skill-install') {
    return Value.Check(SkillInstallApprovalRequestSchema, request)
  }
  return false
}

// ---------- schema 与契约类型的双向绑定(编译时防 drift)----------

type MutuallyAssignable<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false

/** 深层抹掉契约侧的 readonly 修饰(TypeBox Static 表达不了 readonly 数组,结构一致即视为一致)。 */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T

type BindCheck<Actual, Expected extends MutuallyAssignable<Actual, DeepMutable<Expected>> extends true ? unknown : never> =
  Expected

export type _BindSkillProvenance = BindCheck<
  Static<typeof SkillProvenanceSchema>,
  import('../domain/skill').SkillProvenance
>
export type _BindSkillMarketCandidate = BindCheck<
  Static<typeof SkillMarketCandidateSchema>,
  import('../domain/skill').SkillMarketCandidate
>
export type _BindSkillCandidateApproval = BindCheck<
  Static<typeof SkillCandidateApprovalRequestSchema>,
  import('../domain/approval').SkillCandidateApprovalRequest
>
export type _BindSkillInstallApproval = BindCheck<
  Static<typeof SkillInstallApprovalRequestSchema>,
  import('../domain/approval').SkillInstallApprovalRequest
>
export type _BindFileApproval = BindCheck<
  Static<typeof FileApprovalRequestSchema>,
  import('../domain/approval').FileApprovalRequest
>

export type _BindSessionCreate = BindCheck<
  Static<typeof SessionCreateRequestSchema>,
  import('./contracts').IpcRequestMap['session:create']['request']
>
export type _BindSessionOpen = BindCheck<
  Static<typeof SessionOpenRequestSchema>,
  import('./contracts').IpcRequestMap['session:open']['request']
>
export type _BindSessionRename = BindCheck<
  Static<typeof SessionRenameRequestSchema>,
  import('./contracts').IpcRequestMap['session:rename']['request']
>
export type _BindSessionDelete = BindCheck<
  Static<typeof SessionDeleteRequestSchema>,
  import('./contracts').IpcRequestMap['session:delete']['request']
>
export type _BindMessageSend = BindCheck<
  Static<typeof MessageSendRequestSchema>,
  import('./contracts').IpcRequestMap['message:send']['request']
>
export type _BindMessageAbort = BindCheck<
  Static<typeof MessageAbortRequestSchema>,
  import('./contracts').IpcRequestMap['message:abort']['request']
>
export type _BindApprovalRespond = BindCheck<
  Static<typeof ApprovalRespondRequestSchema>,
  import('./contracts').IpcRequestMap['approval:respond']['request']
>
export type _BindSettingsUpdate = BindCheck<
  Static<typeof SettingsUpdateRequestSchema>,
  import('./contracts').IpcRequestMap['settings:update']['request']
>
export type _BindManagerWorkspaceMigrate = BindCheck<
  Static<typeof ManagerWorkspaceMigrateRequestSchema>,
  import('./contracts').IpcRequestMap['managerWorkspace:migrate']['request']
>
export type _BindCredentialSave = BindCheck<
  Static<typeof CredentialSaveRequestSchema>,
  import('./contracts').IpcRequestMap['credential:save']['request']
>
export type _BindCredentialDelete = BindCheck<
  Static<typeof CredentialDeleteRequestSchema>,
  import('./contracts').IpcRequestMap['credential:delete']['request']
>
export type _BindCredentialTest = BindCheck<
  Static<typeof CredentialTestRequestSchema>,
  import('./contracts').IpcRequestMap['credential:test']['request']
>
export type _BindCredentialListModels = BindCheck<
  Static<typeof CredentialListModelsRequestSchema>,
  import('./contracts').IpcRequestMap['credential:listModels']['request']
>
export type _BindRoleGet = BindCheck<
  Static<typeof RoleGetRequestSchema>,
  import('./contracts').IpcRequestMap['role:get']['request']
>
export type _BindRoleCreate = BindCheck<
  Static<typeof RoleCreateRequestSchema>,
  import('./contracts').IpcRequestMap['role:create']['request']
>
export type _BindRoleUpdate = BindCheck<
  Static<typeof RoleUpdateRequestSchema>,
  import('./contracts').IpcRequestMap['role:update']['request']
>
export type _BindRoleUpdateGuardrails = BindCheck<
  Static<typeof RoleUpdateGuardrailsRequestSchema>,
  import('./contracts').IpcRequestMap['role:updateGuardrails']['request']
>
export type _BindRoleArchive = BindCheck<
  Static<typeof RoleArchiveRequestSchema>,
  import('./contracts').IpcRequestMap['role:archive']['request']
>
export type _BindRoleRestore = BindCheck<
  Static<typeof RoleRestoreRequestSchema>,
  import('./contracts').IpcRequestMap['role:restore']['request']
>
export type _BindRoleGetDeleteImpact = BindCheck<
  Static<typeof RoleGetDeleteImpactRequestSchema>,
  import('./contracts').IpcRequestMap['role:getDeleteImpact']['request']
>
export type _BindRoleDelete = BindCheck<
  Static<typeof RoleDeleteRequestSchema>,
  import('./contracts').IpcRequestMap['role:delete']['request']
>
export type _BindSessionArchive = BindCheck<
  Static<typeof SessionArchiveRequestSchema>,
  import('./contracts').IpcRequestMap['session:archive']['request']
>
export type _BindSessionRestore = BindCheck<
  Static<typeof SessionRestoreRequestSchema>,
  import('./contracts').IpcRequestMap['session:restore']['request']
>
export type _BindAgentRunList = BindCheck<
  Static<typeof AgentRunListRequestSchema>,
  import('./contracts').IpcRequestMap['agentRun:list']['request']
>
export type _BindAgentRunGetDetail = BindCheck<
  Static<typeof AgentRunGetDetailRequestSchema>,
  import('./contracts').IpcRequestMap['agentRun:getDetail']['request']
>
export type _BindAgentRunGetGraph = BindCheck<
  Static<typeof AgentRunGetGraphRequestSchema>,
  import('./contracts').IpcRequestMap['agentRun:getGraph']['request']
>
export type _BindAgentRunInterrupt = BindCheck<
  Static<typeof AgentRunInterruptRequestSchema>,
  import('./contracts').IpcRequestMap['agentRun:interrupt']['request']
>
export type _BindSkillOpenFolderRequest = BindCheck<
  Static<typeof SkillOpenFolderRequestSchema>,
  import('./contracts').IpcRequestMap['skill:openFolder']['request']
>
export type _BindSkillUninstallRequest = BindCheck<
  Static<typeof SkillUninstallRequestSchema>,
  import('./contracts').IpcRequestMap['skill:uninstall']['request']
>
export type _BindMemoryListRequest = BindCheck<
  Static<typeof MemoryListPageRequestSchema>,
  import('./contracts').IpcRequestMap['memory:list']['request']
>
export type _BindMemoryDeleteRequest = BindCheck<
  Static<typeof MemoryDeleteRequestSchema>,
  import('./contracts').IpcRequestMap['memory:delete']['request']
>
export type _BindSkillListResponse = BindCheck<
  Static<typeof SkillListSnapshotSchema>,
  import('./contracts').IpcRequestMap['skill:list']['response']
>
export type _BindSkillRefreshResponse = BindCheck<
  Static<typeof SkillListSnapshotSchema>,
  import('./contracts').IpcRequestMap['skill:refresh']['response']
>
export type _BindSkillUninstallResponse = BindCheck<
  Static<typeof SkillListSnapshotSchema>,
  import('./contracts').IpcRequestMap['skill:uninstall']['response']
>
export type _BindSkillOpenFolderResponse = BindCheck<
  Static<typeof VoidResponseSchema>,
  import('./contracts').IpcRequestMap['skill:openFolder']['response']
>
export type _BindMemoryListResponse = BindCheck<
  Static<typeof MemoryListPageSchema>,
  import('./contracts').IpcRequestMap['memory:list']['response']
>
export type _BindMemoryDeleteResponse = BindCheck<
  Static<typeof MemoryDeleteResponseSchema>,
  import('./contracts').IpcRequestMap['memory:delete']['response']
>
export type _BindMemoryClearResponse = BindCheck<
  Static<typeof MemoryClearResponseSchema>,
  import('./contracts').IpcRequestMap['memory:clear']['response']
>
