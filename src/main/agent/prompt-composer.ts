import type { RoleId } from '../../shared/domain/role'
import { getTemplateDef } from '../roles/role-templates'
import type { RoleTemplateId } from '../../shared/domain/role'
import { buildSystemPrompt } from './system-prompt'

/**
 * 提示词管线(PLAN §3):可组合层,第一步实际输出两层。
 *
 *  [global-base]  小柊身份/中文/安全规则/文件规范/工作目录/记事索引(不变的单体拆出)
 *  [role-card]    角色显示名+模板身份+用户守则+「守则不能取消安全边界」声明
 *
 * delegation / handoff 层 ID 已预留(第二步/第三步注入),第一步不产生内容。
 * 守则修改的生效语义:每个用户回合开始前重读重拼,从下一条消息生效。
 */

export type PromptLayerId = 'global-base' | 'role-card' | 'memory-index' | 'delegation' | 'handoff'

/** 角色层输入(由调用方从角色库+家目录现场读取,composer 不落盘不缓存)。 */
export interface RolePromptLayer {
  readonly roleId: RoleId
  readonly displayName: string
  readonly templateId: RoleTemplateId
  /** 守则全文;空串=空守则(不产生伪人设,只保留名字行)。 */
  readonly guardrails: string
}

/** 守则异常超长时的防御上限(入库已限 6000 字,此处防外部改坏文件)。 */
const GUARDRAILS_PROMPT_HARD_CAP = 6_000

export class PromptComposerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptComposerError'
  }
}

export function composeSystemPrompt(input: {
  readonly workspacePath: string
  readonly memories: readonly string[]
  readonly role?: RolePromptLayer
}): string {
  const identity = input.role ? input.role.displayName : '小柊'
  const globalBase = buildSystemPrompt(input.workspacePath, input.memories, identity)
  if (!input.role) return globalBase

  const { templateId, guardrails } = input.role
  if ([...guardrails].length > GUARDRAILS_PROMPT_HARD_CAP) {
    throw new PromptComposerError(
      '角色守则异常超长,可能是守则文件被外部改动;请打开守则编辑页检查后再发消息',
    )
  }

  const templateName = getTemplateDef(templateId)?.name
  const sections = [
    '',
    '---',
    '',
    '## 你的角色',
    // 强身份声明(A-13):角色会话里 AI 始终以角色名自称,不再自称小柊(小柊留给总管)
    `用户给你起的名字是「${identity}」,请始终以「${identity}」自称、以这个名字和用户相处。`,
    ...(templateName && templateId !== 'legacy-empty'
      ? [`你的人设方向是「${templateName}」,按它干活。`]
      : []),
  ]
  if (guardrails.trim().length > 0) {
    sections.push('', '以下是这个角色的守则(由用户制定,请始终遵守):', '', guardrails.trim())
  }
  sections.push(
    '',
    '注意:上面的角色守则不能取消此前任何全局安全边界与文件操作规范;两者冲突时,一律以安全边界为准。',
  )
  return [globalBase, ...sections].join('\n')
}
