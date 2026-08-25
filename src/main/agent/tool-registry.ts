import type { AgentTool } from '@earendil-works/pi-agent-core'
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
}

export function buildTools(deps: ToolRegistryDeps): AgentTool[] {
  const toolDeps: ToolDeps = { ops: deps.ops, trash: deps.trash }
  return [
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
    ...(deps.memoryTools?.() ?? []),
    ...(deps.roleRulesTools?.() ?? []),
  ]
}
