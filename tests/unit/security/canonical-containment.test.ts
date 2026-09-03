import { promises as fs } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureCanonicalDirectory, type CanonicalContainmentFs } from '../../../src/main/security/canonical-containment'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'containment-e5-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('E-5 canonical containment', () => {
  it('逐级创建正常目录，拒绝根/中间/目标 symlink 或 Windows junction', async () => {
    const root = join(dir, 'daweige')
    await expect(ensureCanonicalDirectory(root, join(root, 'skills', 'safe'))).resolves.toBe(join(root, 'skills', 'safe'))
    const outside = join(dir, 'outside'); await mkdir(outside)
    const linkedRoot = join(dir, 'linked-root')
    try { await symlink(outside, linkedRoot, 'junction') } catch { return }
    await expect(ensureCanonicalDirectory(linkedRoot, join(linkedRoot, 'skills'))).rejects.toThrow(/链接/)
    const middleRoot = join(dir, 'middle-root'); await mkdir(middleRoot)
    await symlink(outside, join(middleRoot, 'skills'), 'junction')
    await expect(ensureCanonicalDirectory(middleRoot, join(middleRoot, 'skills', 'x'))).rejects.toThrow(/链接/)
    const targetRoot = join(dir, 'target-root'); await mkdir(join(targetRoot, 'skills'), { recursive: true })
    await symlink(outside, join(targetRoot, 'skills', 'linked-target'), 'junction')
    await expect(ensureCanonicalDirectory(targetRoot, join(targetRoot, 'skills', 'linked-target'))).rejects.toThrow(/链接/)
  })

  it('mkdir 后目录被 TOCTOU 替换成 junction 时复检拒绝，调用方不会继续写到根外', async () => {
    const root = join(dir, 'daweige'); await mkdir(root)
    const outside = join(dir, 'outside'); await mkdir(outside)
    let swapped = false
    const fakeFs: CanonicalContainmentFs = {
      lstat: fs.lstat,
      realpath: fs.realpath,
      mkdir: (async (path, options) => {
        const result = await fs.mkdir(path, options)
        if (!swapped && String(path).endsWith('swap')) {
          swapped = true
          await fs.rmdir(path)
          await fs.symlink(outside, path, 'junction')
        }
        return result
      }) as typeof fs.mkdir,
    }
    await expect(ensureCanonicalDirectory(root, join(root, 'skills', 'swap'), fakeFs)).rejects.toThrow(/链接/)
    await expect(fs.stat(join(outside, 'SKILL.md'))).rejects.toThrow()
  })
})
