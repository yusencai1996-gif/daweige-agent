import { describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '../../../src/main/agent/tool-registry'
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
    ])
  })

  it('绝不包含命令/脚本/安装类工具', () => {
    const forbidden = [
      'bash', 'shell', 'exec', 'spawn', 'run_command', 'command',
      'script', 'powershell', 'cmd', 'install', 'npm', 'pip',
    ]
    for (const name of TOOL_NAMES) {
      for (const bad of forbidden) {
        expect(name.toLowerCase()).not.toContain(bad)
      }
    }
  })

  it('系统提示声明:不执行系统命令 + 确认机制 + 工作文件夹边界', () => {
    const prompt = buildSystemPrompt('C:\\测试')
    expect(prompt).toContain('C:\\测试')
    expect(prompt).toContain('不能执行任何系统命令')
    expect(prompt).toContain('确认')
    expect(prompt).toContain('save_memory')
  })
})
