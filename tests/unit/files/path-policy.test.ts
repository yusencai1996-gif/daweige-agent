import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathPolicy, PathPolicyError, isInside } from '../../../src/main/files/path-policy'

/**
 * M4-01 验证标准:traversal、相似前缀目录、大小写、Junction、待创建路径;
 * 越界不能被字符串前缀判断绕过。
 */

let root: string
let workspace: string
let outside: string
let appData: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daweige-path-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'elsewhere')
  appData = join(root, 'userData')
  await Promise.all([
    mkdir(workspace),
    mkdir(outside),
    mkdir(join(appData, 'data'), { recursive: true }),
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

function policy(): PathPolicy {
  return new PathPolicy(workspace, appData)
}

describe('PathPolicy 区域判定', () => {
  it('工作区内文件 → workspace', async () => {
    const p = join(workspace, 'a.txt')
    await writeFile(p, 'x')
    expect((await policy().classify(p)).zone).toBe('workspace')
  })

  it('工作区外文件 → outside', async () => {
    const p = join(outside, 'a.txt')
    await writeFile(p, 'x')
    expect((await policy().classify(p)).zone).toBe('outside')
  })

  it('应用数据目录 → app-internal', async () => {
    const p = join(appData, 'data', 'memories.json')
    expect((await policy().classify(p)).zone).toBe('app-internal')
  })

  it('待创建路径(不存在):工作区内新建文件 → workspace', async () => {
    const p = join(workspace, 'new-dir', 'new-file.txt')
    expect((await policy().classify(p)).zone).toBe('workspace')
  })

  it('相似前缀目录不算工作区(workspace vs workspace-2)', async () => {
    const sibling = `${workspace}-2`
    await mkdir(sibling)
    expect((await policy().classify(join(sibling, 'a.txt'))).zone).toBe('outside')
  })

  it('大小写差异不影响判定(Windows 不区分大小写)', async () => {
    const p = join(workspace.toUpperCase(), 'a.txt')
    await writeFile(join(workspace, 'a.txt'), 'x')
    expect((await policy().classify(p)).zone).toBe('workspace')
  })

  it('.. traversal 被真实路径化解(不靠字符串前缀)', async () => {
    const p = join(workspace, '..', 'elsewhere', 'a.txt')
    await writeFile(join(outside, 'a.txt'), 'x')
    expect((await policy().classify(p)).zone).toBe('outside')
  })

  it('Junction 指向工作区外:访问工作区内 junction 路径 → outside(解开链接)', async () => {
    const linkDir = join(workspace, 'link-to-outside')
    await symlink(outside, linkDir, 'junction')
    const target = join(linkDir, 'secret.txt')
    await writeFile(join(outside, 'secret.txt'), 'x')
    expect((await policy().classify(target)).zone).toBe('outside')
  })

  it('Junction 指向工作区内:从外面经 junction 进来 → workspace', async () => {
    const linkDir = join(outside, 'link-to-workspace')
    await symlink(workspace, linkDir, 'junction')
    const target = join(linkDir, 'file.txt')
    await writeFile(join(workspace, 'file.txt'), 'x')
    expect((await policy().classify(target)).zone).toBe('workspace')
  })

  it('相对路径直接拒绝', async () => {
    await expect(policy().classify('relative/path.txt')).rejects.toThrow(PathPolicyError)
  })

  it('UNC 路径在无对应共享时给出可读错误(不静默当工作区)', async () => {
    await expect(policy().classify('\\\\nonexistent-server\\share\\a.txt')).rejects.toThrow(
      PathPolicyError,
    )
  })
})

describe('PathPolicy 写校验', () => {
  it('写目标含通配符/保留字符被拒', () => {
    const p = policy()
    expect(() => p.assertWritable(join(workspace, 'a*.txt'))).toThrow(PathPolicyError)
    expect(() => p.assertWritable(join(workspace, 'a?.txt'))).toThrow(PathPolicyError)
    expect(() => p.assertWritable(join(workspace, 'a|b.txt'))).toThrow(PathPolicyError)
    expect(() => p.assertWritable(join(workspace, 'normal.txt'))).not.toThrow()
  })
})

describe('isInside 边界', () => {
  it('目录本身与直接子路径都算 inside,相似前缀不算', () => {
    expect(isInside('C:\\ws\\file.txt', 'C:\\ws')).toBe(true)
    expect(isInside('C:\\ws', 'C:\\ws')).toBe(true)
    expect(isInside('C:\\ws-2\\file.txt', 'C:\\ws')).toBe(false)
    expect(isInside('C:\\WS\\FILE.TXT', 'c:\\ws')).toBe(true)
  })
})
