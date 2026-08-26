import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { PathPolicy } from '../files/path-policy'
import type { FileOps } from '../files/file-ops'
import type { ToolDeps } from './tools/deps'
import { createReadFileTool } from './tools/read-file'
import { createListDirectoryTool } from './tools/list-directory'
import { createWriteFileTool } from './tools/write-file'
import { createEditFileTool } from './tools/edit-file'
import { createMovePathsTool } from './tools/move-paths'
import { createRenamePathTool } from './tools/rename-path'
import { createDeletePathsTool } from './tools/delete-paths'
import { createMakeDirectoryTool } from './tools/make-directory'
import { createReadDocxTool } from './tools/read-docx'
import { createWriteDocxTool } from './tools/write-docx'
import { createReadWorkbookTool } from './tools/read-workbook'
import { createWriteWorkbookTool } from './tools/write-workbook'

/**
 * 工具注册表(M4-07)。
 * 第一版工具白名单——新增工具必须在这里登记并同步更新断言测试。
 * 红线:绝不注册 bash/shell/exec/spawn/script/package install 类工具。
 */

export const TOOL_NAMES = [
  'read_file',
  'list_directory',
  'write_file',
  'edit_file',
  'move_paths',
  'rename_path',
  'delete_paths',
  'make_directory',
  'read_docx',
  'write_docx',
  'read_workbook',
  'write_workbook',
  // M5:
  'save_memory',
  'search_memories',
  // 0.2.0 角色化:
  'edit_role_guardrails',
  // 0.3.0 总管协作工具:
  'spawn_role_agent',
  'wait_agents',
  'list_agents',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export interface ToolRegistryDeps {
  policy: PathPolicy
  ops: FileOps
  trash: (path: string) => Promise<void>
  /** M5 记忆工具;记忆里程碑接入前可为空数组。 */
  memoryTools?: () => AgentTool[]
  /** 0.2.0 守则工具;会话未绑定角色时可不提供(纯对话场景)。 */
  roleRulesTools?: () => AgentTool[]
  /** 批3 orchestrator 注入真实实现;本批缺省为安全拒绝的 schema 骨架。 */
  managerTools?: () => AgentTool[]
}

export type ToolContext = 'regular-worker' | 'manager' | 'delegated-worker'

export function buildTools(
  deps: ToolRegistryDeps,
  context: ToolContext = 'regular-worker',
): AgentTool[] {
  const toolDeps: ToolDeps = { ops: deps.ops, trash: deps.trash }
  const fileTools = [
    createReadFileTool(toolDeps),
    createListDirectoryTool(toolDeps),
    createWriteFileTool(toolDeps),
    createEditFileTool(toolDeps),
    createMovePathsTool(toolDeps),
    createRenamePathTool(toolDeps),
    createDeletePathsTool(toolDeps),
    createMakeDirectoryTool(toolDeps),
    createReadDocxTool(toolDeps),
    createWriteDocxTool(toolDeps),
    createReadWorkbookTool(toolDeps),
    createWriteWorkbookTool(toolDeps),
  ]
  if (context === 'manager') {
    return [
      ...(deps.memoryTools?.() ?? []),
      ...(deps.managerTools?.() ?? createManagerCollaborationSkeletonTools()),
    ]
  }
  if (context === 'delegated-worker') {
    return [...fileTools, ...(deps.roleRulesTools?.() ?? [])]
  }
  return [
    ...fileTools,
    ...(deps.memoryTools?.() ?? []),
    ...(deps.roleRulesTools?.() ?? []),
  ]
}

const EnvelopeFields = {
  userRequest: Type.String({ minLength: 1, maxLength: 100_000 }),
  managerConclusions: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
    maxItems: 20,
  }),
  taskBrief: Type.String({ minLength: 1, maxLength: 4_000 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
    minItems: 1,
    maxItems: 20,
  }),
  allowedWorkspacePaths: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
    minItems: 1,
    maxItems: 8,
  }),
} as const

const SpawnParams = Type.Object(
  { targetRoleId: Type.String({ pattern: '^agent-[0-9a-f]{12}$' }), ...EnvelopeFields },
  { additionalProperties: false },
)
const WaitParams = Type.Object(
  {
    runIds: Type.Array(Type.String({ pattern: '^run-[0-9a-f]{16}$' }), {
      minItems: 1,
      maxItems: 1,
    }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 300_000 })),
  },
  { additionalProperties: false },
)
const ListParams = Type.Object({}, { additionalProperties: false })

/**
 * 本批只冻结名称和 schema。execute fail-closed,避免 orchestrator 未接线时
 * 模型误以为已派出;批3 通过 managerTools 替换为真实实现。
 */
export function createManagerCollaborationSkeletonTools(): AgentTool[] {
  const unavailable = async () => ({
    content: [{ type: 'text' as const, text: '协作调度尚未接线,本次没有派出或等待任何角色。' }],
    details: { available: false },
  })
  return [
    {
      name: 'spawn_role_agent',
      label: '派出角色',
      description: '构造完整派活信封,经用户确认后派出一个 worker。',
      parameters: SpawnParams,
      executionMode: 'sequential',
      execute: unavailable,
    },
    {
      name: 'wait_agents',
      label: '等待派活',
      description: '等待当前总管会话拥有的一次派活。',
      parameters: WaitParams,
      executionMode: 'sequential',
      execute: unavailable,
    },
    {
      name: 'list_agents',
      label: '查看派活',
      description: '列出当前总管会话的派活摘要。',
      parameters: ListParams,
      executionMode: 'sequential',
      execute: unavailable,
    },
  ]
}
