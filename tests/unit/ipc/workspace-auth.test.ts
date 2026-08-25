import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceAuthorization } from '../../../src/main/ipc/workspace-auth'

/** 复审 B-02:工作文件夹一次性授权。 */

let dir: string
let sibling: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-wauth-'))
  sibling = `${dir}-other`
  await mkdir(sibling).catch(() => {})
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(sibling, { recursive: true, force: true }).catch(() => {})
})

describe('WorkspaceAuthorization', () => {
  it('grant 后 consume 成功;一次消费后作废', async () => {
    const auth = new WorkspaceAuthorization()
    await auth.grant(dir)
    expect(await auth.consume(dir)).toBe(true)
    expect(await auth.consume(dir)).toBe(false)
  })

  it('未授权路径拒绝(渲染进程伪造 C:\ 之类直接 create)', async () => {
    const auth = new WorkspaceAuthorization()
    expect(await auth.consume(dir)).toBe(false)
  })

  it('授权 A 不能消费 B(路径不匹配)', async () => {
    const auth = new WorkspaceAuthorization()
    await auth.grant(dir)
    expect(await auth.consume(sibling)).toBe(false)
  })

  it('不存在的路径 grant/consume 均失败', async () => {
    const auth = new WorkspaceAuthorization()
    await auth.grant(join(dir, 'ghost'))
    expect(await auth.consume(join(dir, 'ghost'))).toBe(false)
  })

  it('大小写与斜杠差异不影响匹配(Windows 口径)', async () => {
    const auth = new WorkspaceAuthorization()
    await auth.grant(dir)
    const variant = dir.toUpperCase().replace(/\\/g, '/')
    // realpath 会把斜杠归一为反斜杠;直接用大小写变体验证
    expect(await auth.consume(dir.toUpperCase())).toBe(true)
    void variant
  })
})
