import { formatSkillInvocation, type AgentTool, type Skill } from '@earendil-works/pi-agent-core'
import { Type, type Static } from 'typebox'
import { redactCommonSecrets } from '../../security/redaction'

const ReadSkillParams = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128, description: '技能名称' }),
  },
  { additionalProperties: false },
)

export interface SessionSkillSnapshot {
  readonly skills: readonly Skill[]
}

/** 只读会话创建时冻结的技能正文；绝不回落到通用文件读取。 */
export function createReadSkillTool(snapshot: SessionSkillSnapshot): AgentTool<typeof ReadSkillParams> {
  return {
    name: 'read_skill',
    label: '读取技能',
    description: '按名称读取当前会话可用技能的完整 Markdown 工作方法。',
    parameters: ReadSkillParams,
    executionMode: 'sequential',
    execute: async (_toolCallId, params: Static<typeof ReadSkillParams>) => {
      const matches = snapshot.skills.filter((skill) => skill.name === params.name)
      if (matches.length === 0) {
        throw new Error(`当前会话没有名为「${redactCommonSecrets(params.name)}」的技能`)
      }
      if (matches.length !== 1) {
        throw new Error(`当前会话中技能「${redactCommonSecrets(params.name)}」存在歧义,已拒绝读取`)
      }
      const skill = matches[0]
      if (!skill) throw new Error('技能快照异常,已拒绝读取')
      return {
        content: [{ type: 'text', text: formatSkillInvocation(skill) }],
        details: {
          name: redactCommonSecrets(skill.name),
          logicalLocation: redactCommonSecrets(skill.filePath),
        },
      }
    },
  }
}
