import { Type, type Static } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { RoleRepository } from '../../roles/role-repository'
import type { RoleService } from '../../roles/role-service'
import { checkGuardrails } from '../../roles/role-files'

/**
 * AI 修改当前角色守则的核心工具(PLAN §3.3)。
 *
 * 安全设计:
 * - 无 path/roleId 参数:固定操作"当前会话所属角色"的守则,主进程内部解析路径;
 * - 只做精确片段替换(唯一匹配),不支持删除/移动/改名角色家目录;
 * - 审批闸门(approval-gate)对它永远逐次弹卡,不吃任何会话级授权;
 * - execute 落盘前二次校验绑定+字数+乐观并发,防确认后状态变化;
 * - 生效语义:当前工具循环不换提示词,下一条用户消息生效(与 UI 保存一致)。
 */

const EditRoleGuardrailsParams = Type.Object(
  {
    old_string: Type.String({
      minLength: 1,
      maxLength: 6_000,
      description: '守则中要被替换的原文片段;必须与守则内容精确一致,且只在守则里出现一次',
    }),
    new_string: Type.String({
      maxLength: 6_000,
      description: '替换后的新内容;传空字符串表示删除这段内容',
    }),
  },
  { additionalProperties: false },
)

export interface EditRoleGuardrailsDeps {
  readonly sessionId: string
  readonly roleRepository: RoleRepository
  readonly roleService: RoleService
}

export function createEditRoleGuardrailsTool(deps: EditRoleGuardrailsDeps): AgentTool<typeof EditRoleGuardrailsParams> {
  return {
    name: 'edit_role_guardrails',
    label: '改守则',
    description:
      '修改当前角色的守则(用户的角色规矩)。用精确片段替换:old_string 必须原样摘自守则且只出现一次。修改会先弹确认卡让用户批准;批准后从用户的下一条消息开始生效。不要用它改守则以外的任何文件。',
    parameters: EditRoleGuardrailsParams,
    executionMode: 'sequential',
    execute: async (_id, params: Static<typeof EditRoleGuardrailsParams>) => {
      // 二次校验一:会话必须仍绑定在角色上
      const binding = await deps.roleRepository.getBinding(deps.sessionId)
      if (!binding) {
        throw new Error('这次会话没有挂在角色下,改不了守则。请让用户在守则编辑页手动修改。')
      }
      // 二次校验二:读最新守则并做唯一匹配替换
      let current: { text: string; version: number }
      try {
        current = await deps.roleService.readGuardrailsOf(binding.roleId)
      } catch {
        throw new Error('角色守则文件读不到,这次修改没有执行;请让用户检查角色档案。')
      }
      const first = current.text.indexOf(params.old_string)
      if (first === -1) {
        throw new Error(
          '守则里找不到要替换的原句。请先引用守则里的原文(逐字一致),再发起修改;如果用户刚手动改过守则,以最新内容为准。',
        )
      }
      if (current.text.indexOf(params.old_string, first + 1) !== -1) {
        throw new Error(
          '要替换的片段在守则里出现了不止一次,没法确定改哪处。请在 old_string 里多带一些上下文,让它只出现一次。',
        )
      }
      const replaced =
        current.text.slice(0, first) + params.new_string + current.text.slice(first + params.old_string.length)
      // 二次校验三:字数/字节上限(确认期间守则可能被改大)
      const check = checkGuardrails(replaced)
      if (!check.ok) {
        throw new Error(`${check.message} 这次修改没有执行。`)
      }
      // 乐观并发:确认期间用户在别处保存过守则 → 版本冲突,要求重读
      try {
        await deps.roleService.updateGuardrails(binding.roleId, replaced, current.version)
      } catch {
        throw new Error('守则刚被用户改过,你的修改基于旧版本,这次没有执行。请重新查看守则内容后再试一次。')
      }
      return {
        content: [
          {
            type: 'text',
            text: '守则已更新(用户已批准)。新守则从用户的下一条消息开始生效;当前这轮回复继续按原守则走。',
          },
        ],
        details: { roleId: binding.roleId, version: current.version + 1 },
      }
    },
  }
}
