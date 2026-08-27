import { Type, type Static, type TObject, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { ContractChannel, RequestOf } from './contracts'

/**
 * 全部 IPC 入参的运行时 schema(M1-04)。
 * 安全前提:渲染进程不可信,主进程每个 handler 必须先过 validateRequest。
 */

const strict = { additionalProperties: false } as const

// ---------- 基础构件 ----------

const ProviderIdSchema = Type.Union([
  Type.Literal('kimi-coding'),
  Type.Literal('zai'),
  Type.Literal('zai-coding-cn'),
  Type.Literal('deepseek'),
])

const SessionIdSchema = Type.String({ minLength: 1, maxLength: 64 })

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
    providerId: ProviderIdSchema,
    modelId: Type.String({ minLength: 1, maxLength: 100 }),
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

export const ProviderSelectionSchema = Type.Object(
  {
    providerId: ProviderIdSchema,
    modelId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  strict,
)

export const SettingsSchema = Type.Object(
  {
    providerSelection: ProviderSelectionSchema,
    enabledModels: Type.Optional(Type.Array(ProviderSelectionSchema, { maxItems: 32, uniqueItems: true })),
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

export const MemoryDeleteRequestSchema = Type.Object(
  {
    memoryId: SessionIdSchema,
  },
  strict,
)

// ---------- 通道 → schema 映射 ----------

/** 有实际入参的通道才登记 schema;request 为 void 的通道无需校验。 */
export const REQUEST_SCHEMAS: Readonly<Partial<Record<ContractChannel, TObject>>> = {
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
  'memory:delete': MemoryDeleteRequestSchema,
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
