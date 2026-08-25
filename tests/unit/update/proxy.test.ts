import { describe, expect, it } from 'vitest'
import { buildUpdatePac } from '../../../src/main/update/proxy'

/** PAC 生成纯函数测试(读注册表部分依赖本机,不进单测)。 */
describe('update proxy PAC', () => {
  it('仅更新域名走代理,其余 DIRECT', () => {
    const pac = buildUpdatePac('127.0.0.1:7897')
    expect(pac).toContain("dnsDomainIs(host, 'agent.daweige.host')")
    expect(pac).toContain('PROXY 127.0.0.1:7897; DIRECT')
    expect(pac).toContain("return 'DIRECT'")
  })

  it('自定义域名生效', () => {
    const pac = buildUpdatePac('192.168.1.2:8888', 'example.com')
    expect(pac).toContain("dnsDomainIs(host, 'example.com')")
    expect(pac).toContain('PROXY 192.168.1.2:8888; DIRECT')
  })

  it('代理地址不含换行/引号(防 PAC 注入)', () => {
    const pac = buildUpdatePac('127.0.0.1:7897')
    expect(pac).not.toContain('"')
    expect(pac).not.toContain('\n')
  })
})
