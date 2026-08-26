import { describe, expect, it } from 'vitest'
import { extractRoleDrafts } from '../../../src/renderer/features/manager/role-draft-parser'

/** 拼一个 daweige-role-draft  fenced block(信息串可换,正文原样放入)。 */
function block(info: string, body: string): string {
  return '```' + info + '\n' + body + '\n```'
}

const GOOD_JSON = JSON.stringify({
  displayName: '小账',
  guardrails: '# 角色守则\n\n## 身份\n你是小账。',
})

describe('extractRoleDrafts(PLAN §10.5)', () => {
  it('好块(新角色):剔除出正文,解析出 displayName/guardrails,targetRoleId 为 null', () => {
    const text = `先看看这个:\n\n${block('daweige-role-draft', GOOD_JSON)}\n\n点卡片继续。`
    const result = extractRoleDrafts(text)
    expect(result.drafts).toEqual([
      { displayName: '小账', guardrails: '# 角色守则\n\n## 身份\n你是小账。', targetRoleId: null },
    ])
    expect(result.text).toBe('先看看这个:\n\n点卡片继续。')
    expect(result.text).not.toContain('daweige-role-draft')
  })

  it('好块(带 @v1 版本号与 targetRoleId):同样识别', () => {
    const json = JSON.stringify({
      displayName: '小编',
      guardrails: '# 角色守则\n补充一条。',
      targetRoleId: 'agent-a1b2c3d4e5f6',
    })
    const result = extractRoleDrafts(block('daweige-role-draft@v1', json))
    expect(result.drafts).toEqual([
      { displayName: '小编', guardrails: '# 角色守则\n补充一条。', targetRoleId: 'agent-a1b2c3d4e5f6' },
    ])
    expect(result.text).toBe('')
  })

  it('坏块一律当普通文本:JSON 坏/字段缺/名字超长/守则超界/版本不对/未闭合', () => {
    const cases = [
      block('daweige-role-draft', '{ "displayName": "坏掉", "guardrails": '), // JSON 坏
      block('daweige-role-draft', JSON.stringify({ displayName: '没守则' })), // 缺 guardrails
      block('daweige-role-draft', JSON.stringify({ guardrails: '没名字' })), // 缺 displayName
      block('daweige-role-draft', JSON.stringify({ displayName: '这个名字实在是太长太长太长太长太长太长太长太长太长了', guardrails: 'x' })), // 26 字,超 24 上限
      block('daweige-role-draft', JSON.stringify({ displayName: '小账', guardrails: '' })), // 守则空
      block('daweige-role-draft', JSON.stringify({ displayName: '小账', guardrails: 'x', targetRoleId: 42 })), // targetRoleId 类型坏
      block('daweige-role-draft@v2', GOOD_JSON), // 未知版本
      block('markdown', GOOD_JSON), // 信息串不是草稿标记
    ]
    for (const text of cases) {
      const result = extractRoleDrafts(text)
      expect(result.drafts).toEqual([])
      expect(result.text).toBe(text) // 一个字符都不动
    }
    // 未闭合(流式半截):整块留作文本
    const open = '```daweige-role-draft\n' + GOOD_JSON
    expect(extractRoleDrafts(open)).toEqual({ text: open, drafts: [] })
  })

  it('同一条消息:好块成卡、坏块留正文,互不干扰', () => {
    const good = block('daweige-role-draft', GOOD_JSON)
    const bad = block('daweige-role-draft', '{ nope')
    const text = `前面的话\n\n${good}\n\n中间\n\n${bad}\n\n收尾`
    const result = extractRoleDrafts(text)
    expect(result.drafts).toHaveLength(1)
    expect(result.text).toContain(bad) // 坏块原样保留
    expect(result.text).not.toContain(good)
    expect(result.text).toContain('前面的话')
    expect(result.text).toContain('收尾')
  })

  it('一条消息多块好草稿:全部成卡', () => {
    const text = `${block('daweige-role-draft', GOOD_JSON)}\n\n${block('daweige-role-draft', GOOD_JSON)}`
    const result = extractRoleDrafts(text)
    expect(result.drafts).toHaveLength(2)
    expect(result.text).toBe('')
  })

  it('剔除后留下的 3 个以上连续换行被收成两段空行,排版不塌', () => {
    const text = `前文\n\n\n${block('daweige-role-draft', GOOD_JSON)}\n\n\n后文`
    const result = extractRoleDrafts(text)
    expect(result.text).toBe('前文\n\n后文')
  })

  it('字段值前后空白会被收掉;守则长度按码点计(emoji 不多算)', () => {
    const json = JSON.stringify({
      displayName: '  小账  ',
      guardrails: '  # 守则🙂  ',
    })
    const result = extractRoleDrafts(block('daweige-role-draft', json))
    expect(result.drafts).toEqual([{ displayName: '小账', guardrails: '# 守则🙂', targetRoleId: null }])
    // 6000 码点上限:刚好 6000(含 emoji)合法,6001 坏块
    const max = JSON.stringify({ displayName: '小账', guardrails: 'x'.repeat(5999) + '🙂' })
    expect(extractRoleDrafts(block('daweige-role-draft', max)).drafts).toHaveLength(1)
    const over = JSON.stringify({ displayName: '小账', guardrails: 'x'.repeat(6001) })
    expect(extractRoleDrafts(block('daweige-role-draft', over)).drafts).toHaveLength(0)
  })
})
