import { describe, expect, it } from 'vitest'
import { composeSystemPrompt, PromptComposerError } from '../../../src/main/agent/prompt-composer'
import { buildSystemPrompt } from '../../../src/main/agent/system-prompt'

/**
 * 提示词管线单测(PLAN §10.1 提示词组):
 * 层顺序、守则注入、空守则无伪人设、超长防御、全局底子完整性。
 */

const WS = 'C:\\Users\\demo\\Documents\\稿件'
const ROLE = {
  roleId: 'agent-a1b2c3d4e5f6',
  displayName: '小编',
  templateId: 'writer' as const,
  guardrails: '# 角色守则\n\n## 不要做\n- 不写空话',
}

describe('PromptComposer(第一步两层)', () => {
  it('global-base 永远先于 role-card;全局底子逐字保留(身份句带角色名)', () => {
    const prompt = composeSystemPrompt({ workspacePath: WS, memories: ['妈妈生日(生日,每年3月5日)'], role: ROLE })
    const globalBase = buildSystemPrompt(WS, ['妈妈生日(生日,每年3月5日)'], '小编')
    expect(prompt.startsWith(globalBase)).toBe(true)
    expect(prompt.indexOf(globalBase)).toBeLessThan(prompt.indexOf('你的角色'))
  })

  it('角色守则全文注入;身份=纯角色名强自称+模板人设另起一行(A-13)', () => {
    const prompt = composeSystemPrompt({ workspacePath: WS, memories: [], role: ROLE })
    expect(prompt).toContain('请始终以「小编」自称')
    expect(prompt).toContain('人设方向是「写稿助手」')
    expect(prompt).toContain('- 不写空话')
    expect(prompt).not.toContain('小柊')
  })

  it('守则不能取消安全边界:安全声明存在且在守则之后', () => {
    const prompt = composeSystemPrompt({ workspacePath: WS, memories: [], role: ROLE })
    const noticeIdx = prompt.indexOf('角色守则不能取消此前任何全局安全边界')
    expect(noticeIdx).toBeGreaterThan(0)
    expect(noticeIdx).toBeGreaterThan(prompt.indexOf('- 不写空话'))
  })

  it('空守则不产生伪人设:只有身份行,没有守则段', () => {
    const prompt = composeSystemPrompt({
      workspacePath: WS,
      memories: [],
      role: { ...ROLE, guardrails: '' },
    })
    expect(prompt).toContain('请始终以「小编」自称')
    expect(prompt).not.toContain('以下是这个角色的守则')
  })

  it('legacy-empty 模板:身份行不带模板名(旧会话角色无人设)', () => {
    const prompt = composeSystemPrompt({
      workspacePath: WS,
      memories: [],
      role: { ...ROLE, displayName: '未找到文件夹的旧会话-abc123', templateId: 'legacy-empty', guardrails: '' },
    })
    expect(prompt).toContain('「未找到文件夹的旧会话-abc123」')
    expect(prompt).not.toContain('写稿助手')
  })

  it('守则异常超长(>6000 字,外部改坏文件场景)抛中文错误,不静默截断', () => {
    expect(() =>
      composeSystemPrompt({
        workspacePath: WS,
        memories: [],
        role: { ...ROLE, guardrails: '守'.repeat(6_001) },
      }),
    ).toThrow(PromptComposerError)
  })

  it('无角色层(会话无绑定防御):退回纯全局底子,与旧行为一致', () => {
    const prompt = composeSystemPrompt({ workspacePath: WS, memories: [] })
    expect(prompt).toBe(buildSystemPrompt(WS, []))
    expect(prompt).not.toContain('你的角色')
  })

  it('记事索引(memory-index)继续存在于 global-base 中,顺序稳定', () => {
    const prompt = composeSystemPrompt({ workspacePath: WS, memories: ['A(偏好)', 'B(生日,每年3月5日)'], role: ROLE })
    expect(prompt.indexOf('A(偏好)')).toBeLessThan(prompt.indexOf('B(生日,每年3月5日)'))
    expect(prompt.indexOf('B(生日,每年3月5日)')).toBeLessThan(prompt.indexOf('你的角色'))
  })
})
