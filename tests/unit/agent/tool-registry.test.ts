import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  buildTools,
  TOOL_NAMES,
  type ToolRegistryDeps,
} from '../../../src/main/agent/tool-registry'
import { buildSystemPrompt } from '../../../src/main/agent/system-prompt'

/**
 * M4-07 验证标准:工具名快照;无命令/shell 类工具;系统提示同步声明边界。
 * (生产源无 child_process 的扫描在 tests/unit/security/redline-scan.test.ts)
 */

describe('工具白名单(M4-07)', () => {
  it('第一版工具名快照', () => {
    expect([...TOOL_NAMES]).toEqual([
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
      'save_memory',
      'search_memories',
      'edit_role_guardrails',
      'spawn_role_agent',
      'wait_agents',
      'list_agents',
    ])
  })

  it('绝不包含命令/脚本/安装类工具', () => {
    const forbidden = [
      'bash', 'shell', 'exec', 'spawn', 'run_command', 'command',
      'script', 'powershell', 'cmd', 'install', 'npm', 'pip',
    ]
    for (const name of TOOL_NAMES.filter((name) => name !== 'spawn_role_agent')) {
      for (const bad of forbidden) {
        expect(name.toLowerCase()).not.toContain(bad)
      }
    }
  })

  it('三类工具白名单严格分离', () => {
    const deps = {
      policy: {},
      ops: {},
      trash: async () => {},
      memoryTools: () => [fakeTool('save_memory'), fakeTool('search_memories')],
      roleRulesTools: () => [fakeTool('edit_role_guardrails')],
    } as unknown as ToolRegistryDeps
    const manager = buildTools(deps, 'manager').map((tool) => tool.name)
    expect(manager).toEqual([
      'save_memory',
      'search_memories',
      'spawn_role_agent',
      'wait_agents',
      'list_agents',
    ])
    expect(manager).not.toContain('read_file')
    expect(manager).not.toContain('edit_role_guardrails')

    const regular = buildTools(deps, 'regular-worker').map((tool) => tool.name)
    expect(regular).toContain('read_file')
    expect(regular).toContain('save_memory')
    expect(regular).toContain('edit_role_guardrails')
    expect(regular).not.toContain('spawn_role_agent')

    const delegated = buildTools(deps, 'delegated-worker').map((tool) => tool.name)
    expect(delegated).toContain('read_file')
    expect(delegated).toContain('edit_role_guardrails')
    expect(delegated).not.toContain('save_memory')
    expect(delegated).not.toContain('spawn_role_agent')
  })

  it('协作工具 schema 不接收模型伪造 runId/sessionId,wait 只允许一个 run', () => {
    const deps = {
      policy: {}, ops: {}, trash: async () => {}, memoryTools: () => [],
    } as unknown as ToolRegistryDeps
    const tools = buildTools(deps, 'manager')
    const spawn = tools.find((tool) => tool.name === 'spawn_role_agent')
    const spawnSchema = spawn?.parameters as unknown as {
      properties?: Record<string, unknown>
      additionalProperties?: boolean
    }
    expect(Object.keys(spawnSchema.properties ?? {})).toEqual([
      'targetRoleId',
      'userRequest',
      'managerConclusions',
      'taskBrief',
      'acceptanceCriteria',
      'allowedWorkspacePaths',
    ])
    expect(spawnSchema.properties).not.toHaveProperty('runId')
    expect(spawnSchema.properties).not.toHaveProperty('sessionId')
    expect(spawnSchema.additionalProperties).toBe(false)

    const wait = tools.find((tool) => tool.name === 'wait_agents')
    const waitSchema = wait?.parameters as unknown as {
      properties?: { runIds?: { minItems?: number; maxItems?: number }; timeoutMs?: { minimum?: number; maximum?: number } }
    }
    expect(waitSchema.properties?.runIds).toMatchObject({ minItems: 1, maxItems: 1 })
    expect(waitSchema.properties?.timeoutMs).toMatchObject({ minimum: 10_000, maximum: 300_000 })
  })

  it('系统提示声明:不执行系统命令 + 确认机制 + 工作文件夹边界', () => {
    const prompt = buildSystemPrompt('C:\\测试')
    expect(prompt).toContain('C:\\测试')
    expect(prompt).toContain('不能执行任何系统命令')
    expect(prompt).toContain('确认')
    expect(prompt).toContain('save_memory')
  })
})

function fakeTool(name: string): AgentTool {
  return { name } as AgentTool
}
