import { describe, expect, it } from 'vitest'
import { redactCommonSecrets } from '../../../src/main/security/redaction'

/** 复审 S-02:日志通用形态脱敏。 */

describe('redactCommonSecrets', () => {
  it('sk- 形态的 key 被打码', () => {
    expect(redactCommonSecrets('boom at sk-AbCdEf123456789 end')).not.toContain('sk-AbCdEf123456789')
    expect(redactCommonSecrets('boom at sk-AbCdEf123456789 end')).toContain('sk-Ab***')
  })

  it('key=value / Authorization 头形态被打码', () => {
    expect(redactCommonSecrets('api_key=verysecretvalue123')).not.toContain('verysecretvalue123')
    expect(redactCommonSecrets('Authorization: Bearer abcdef123456')).toMatch(/Authorization: Bearer \*\*\*/)
  })

  it('普通错误消息不受影响', () => {
    const msg = 'ENOENT: no such file or directory, open C:\\test\\a.txt'
    expect(redactCommonSecrets(msg)).toBe(msg)
  })
})
