import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileOps, FileOpsError } from '../../../src/main/files/file-ops'
import { PathPolicy } from '../../../src/main/files/path-policy'

/** M4-03/04:文件操作执行层(中文/UTF-8 BOM/空文件/批量部分失败/app-internal 拒绝)。 */

let root: string
let workspace: string
let appData: string
let ops: FileOps

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daweige-ops-'))
  workspace = join(root, 'ws')
  appData = join(root, 'userData')
  await Promise.all([mkdir(workspace), mkdir(join(appData, 'data'), { recursive: true })])
  ops = new FileOps(new PathPolicy(workspace, appData))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

describe('FileOps 文本读写', () => {
  it('中文 + UTF-8 BOM 剥离 + 空文件', async () => {
    await writeFile(join(workspace, 'bom.txt'), '\ufeff你好,大微阁', 'utf-8')
    expect(await ops.readText(join(workspace, 'bom.txt'))).toBe('你好,大微阁')

    await writeFile(join(workspace, 'empty.txt'), '', 'utf-8')
    expect(await ops.readText(join(workspace, 'empty.txt'))).toBe('')
  })

  it('写后读 round-trip', async () => {
    const p = join(workspace, 'out.md')
    await ops.writeText(p, '# 标题\n内容')
    expect(await ops.readText(p)).toBe('# 标题\n内容')
  })

  it('二进制文件给出可读错误', async () => {
    const p = join(workspace, 'bin.dat')
    await writeFile(p, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]))
    await expect(ops.readText(p)).rejects.toThrow(/二进制/)
  })

  it('应用内部数据拒绝读取', async () => {
    await expect(ops.readText(join(appData, 'data', 'memories.json'))).rejects.toThrow(
      FileOpsError,
    )
  })
})

describe('FileOps 编辑', () => {
  it('唯一匹配替换成功', async () => {
    const p = join(workspace, 'edit.txt')
    await ops.writeText(p, '第一段\n要改的句子\n第三段')
    const count = await ops.editText(p, '要改的句子', '改好的句子')
    expect(count).toBe(1)
    expect(await ops.readText(p)).toContain('改好的句子')
  })

  it('无匹配:可读错误', async () => {
    const p = join(workspace, 'edit.txt')
    await ops.writeText(p, '内容')
    await expect(ops.editText(p, '不存在的片段', 'x')).rejects.toThrow(/没找到/)
  })

  it('多处匹配:拒绝改,提示提供更长片段', async () => {
    const p = join(workspace, 'edit.txt')
    await ops.writeText(p, '重复\n重复\n重复')
    await expect(ops.editText(p, '重复', 'x')).rejects.toThrow(/不确定改哪个/)
  })
})

describe('FileOps 批量操作', () => {
  it('移动:全部成功', async () => {
    await ops.writeText(join(workspace, 'a.txt'), 'A')
    await ops.writeText(join(workspace, 'b.txt'), 'B')
    const dest = join(workspace, 'dest')
    const results = await ops.movePaths([join(workspace, 'a.txt'), join(workspace, 'b.txt')], dest)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await ops.readText(join(dest, 'a.txt'))).toBe('A')
  })

  it('移动:预检失败(源不存在)全部不执行,如实说明', async () => {
    await ops.writeText(join(workspace, 'a.txt'), 'A')
    const results = await ops.movePaths(
      [join(workspace, 'a.txt'), join(workspace, 'ghost.txt')],
      join(workspace, 'dest'),
    )
    expect(results.every((r) => !r.ok)).toBe(true)
    expect(results[1]!.error).toContain('不存在')
    // 预检失败:存在的源也没有被移动
    expect(await ops.fileExists(join(workspace, 'a.txt'))).toBe(true)
  })

  it('移动:目标已有同名项时预检失败,不覆盖', async () => {
    await ops.writeText(join(workspace, 'a.txt'), 'A')
    const dest = join(workspace, 'dest')
    await ops.makeDirectory(dest)
    await ops.writeText(join(dest, 'a.txt'), '旧内容')
    const results = await ops.movePaths([join(workspace, 'a.txt')], dest)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain('同名')
    expect(await ops.readText(join(dest, 'a.txt'))).toBe('旧内容')
  })

  it('重命名:拒绝带分隔符的新名字', async () => {
    await ops.writeText(join(workspace, 'a.txt'), 'A')
    await expect(ops.renamePath(join(workspace, 'a.txt'), '../evil')).rejects.toThrow(
      /路径分隔符/,
    )
  })

  it('删除走注入的 trash(测试计数),部分失败如实上报', async () => {
    await ops.writeText(join(workspace, 'x.txt'), 'X')
    const trashed: string[] = []
    const results = await ops.deletePaths(
      [join(workspace, 'x.txt'), join(workspace, 'ghost.txt')],
      async (p) => {
        trashed.push(p)
        if (p.endsWith('ghost.txt')) throw new Error('ENOENT: not found')
      },
    )
    expect(trashed).toEqual([join(workspace, 'x.txt')])
    expect(results[0]!.ok).toBe(true)
    expect(results[1]!.ok).toBe(false)
  })

  it('写目标含通配符被拒', async () => {
    await expect(ops.writeText(join(workspace, 'a*.txt'), 'x')).rejects.toThrow(
      /不允许的字符/,
    )
  })

  it('应用内部数据拒绝写入', async () => {
    await expect(ops.writeText(join(appData, 'data', 'evil.json'), '{}')).rejects.toThrow(
      /应用内部/,
    )
  })
})
