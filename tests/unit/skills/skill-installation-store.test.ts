import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillInstallationStore } from '../../../src/main/skills/market/skill-installation-store'
import { SCRIPT_SKILL_REJECTION } from '../../../src/main/skills/market/skill-script-detector'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'skill-install-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const markdown = (name = 'safe-skill', body = '# 正文') => `---\nname: ${name}\ndescription: 安全说明\n---\n\n${body}\n`
const provenance = {
  kind: 'market' as const, registryId: 'curated' as const, registryName: '精选目录',
  slug: 'safe-skill', owner: 'daweige', version: '1', license: 'MIT', installedAt: 1,
}

describe('SkillInstallationStore', () => {
  it('双解析、打码、marker 与原子提升完成纯 Markdown 安装', async () => {
    const store = new SkillInstallationStore(root)
    const secret = 'sk-12345678901234567890'
    const prepared = await store.prepare({ markdown: markdown('safe-skill', `正文 ${secret}`), provenance })
    expect(prepared.markdown).not.toContain(secret)
    await store.install(prepared)
    const installed = await readFile(join(root, 'safe-skill', 'SKILL.md'), 'utf8')
    expect(installed).not.toContain(secret)
    expect((await store.readSourceRecord(join(root, 'safe-skill')))?.provenance.kind).toBe('market')
  })

  it('自产技能复用同一校验链并记录 authored provenance', async () => {
    const store = new SkillInstallationStore(root)
    const prepared = await store.prepare({
      markdown: markdown('authored-skill'),
      expectedName: 'authored-skill',
      provenance: { kind: 'authored' },
    })
    await store.verifyPrepared(prepared)
    await store.install(prepared)
    expect((await store.readSourceRecord(join(root, 'authored-skill')))?.provenance)
      .toEqual({ kind: 'authored' })
  })

  it.each([
    'name: "safe-skill" # comment',
    "name: 'safe-skill'",
  ])('完全交给 pi 解析其接受的 YAML name 形态:%s', async (nameLine) => {
    const store = new SkillInstallationStore(root)
    const source = `---\n${nameLine}\ndescription: 安全说明\n---\n\n# 正文\n`
    const prepared = await store.prepare({ markdown: source, provenance })
    expect(prepared.name).toBe('safe-skill')
    await store.discard(prepared)
  })

  it.each(['Safe-Skill', 'safe--skill', '-safe-skill'])('pi 判定非法的 name 继续拒绝:%s', async (name) => {
    const store = new SkillInstallationStore(root)
    await expect(store.prepare({ markdown: markdown(name), provenance })).rejects.toThrow(/格式校验/)
  })

  it('probe 同名碰撞回归:name 恰为旧 probe 目录名也能正常安装(复核建议)', async () => {
    const store = new SkillInstallationStore(root)
    const prepared = await store.prepare({
      markdown: markdown('daweige-probe-skill'),
      provenance,
    })
    expect(prepared.name).toBe('daweige-probe-skill')
    await store.discard(prepared)
  })

  it('name 呈密钥形态时拒绝安装(打码后名称规则兜底,复核建议)', async () => {
    const store = new SkillInstallationStore(root)
    await expect(store.prepare({
      markdown: `---
name: sk-12345678901234567890
description: 测试
---

# 正文
`,
      provenance,
    })).rejects.toThrow()
  })

  it.each(['probe-skill', 'staged-skill', 'source-record'] as const)(
    '故障注入:%s 写入后中断时 staging 任一快照均无 secret 明文',
    async (failureStage) => {
      const secret = 'sk-12345678901234567890'
      const snapshots: string[] = []
      const stageRoot = join(root, failureStage)
      const store = new SkillInstallationStore(stageRoot, {
        afterStagingWrite: async (stage, stagingRoot) => {
          snapshots.push((await readTreeText(stagingRoot)).join('\n'))
          if (stage === failureStage) throw new Error(`模拟中断:${stage}`)
        },
      })

      await expect(store.prepare({
        markdown: markdown('safe-skill', `正文 ${secret}`),
        provenance,
      })).rejects.toThrow(/模拟中断/)
      expect(snapshots.length).toBeGreaterThan(0)
      expect(snapshots.every((snapshot) => !snapshot.includes(secret))).toBe(true)
    },
  )

  it('无 frontmatter、name 不匹配、脚本和同名覆盖全部 fail closed', async () => {
    const store = new SkillInstallationStore(root)
    await expect(store.prepare({ markdown: '# none', provenance })).rejects.toThrow(/name/)
    await expect(store.prepare({ markdown: markdown('other'), expectedName: 'safe-skill', provenance })).rejects.toThrow(/不一致/)
    await expect(store.prepare({ markdown: markdown('safe-skill', 'python ./run.py'), provenance })).rejects.toThrow(SCRIPT_SKILL_REJECTION)
    await mkdir(join(root, 'safe-skill'), { recursive: true })
    await writeFile(join(root, 'safe-skill', 'SKILL.md'), markdown())
    const prepared = await store.prepare({ markdown: markdown(), provenance })
    await expect(store.install(prepared)).rejects.toThrow(/同名/)
  })
})

async function readTreeText(dir: string): Promise<string[]> {
  const texts: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) texts.push(...await readTreeText(path))
    else texts.push(await readFile(path, 'utf8'))
  }
  return texts
}
