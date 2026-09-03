import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalBroker } from '../../../src/main/agent/approval-broker'
import { createApprovalGate } from '../../../src/main/agent/approval-gate'
import { createWriteFileTool } from '../../../src/main/agent/tools/write-file'
import { FileOps } from '../../../src/main/files/file-ops'
import { PathPolicy } from '../../../src/main/files/path-policy'
import { DefaultManagedSkillWriteResolver } from '../../../src/main/skills/managed-skill-write'
import { SkillCatalogService } from '../../../src/main/skills/skill-catalog-service'
import { SkillInstallationStore } from '../../../src/main/skills/market/skill-installation-store'
import type { AgentPushEvent } from '../../../src/shared/ipc/events'
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core'

let root: string
let userData: string
let workspace: string
let catalog: SkillCatalogService
let resolver: DefaultManagedSkillWriteResolver
let broker: ApprovalBroker
let events: AgentPushEvent[]

const markdown = (name: string, body = '## 步骤\n\n1. 做好事情\n\n## 自检\n\n- [ ] 已完成\n') =>
  `---\nname: ${name}\ndescription: 处理可复用测试任务时使用。\n---\n\n# 测试技能\n\n${body}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-skill-write-'))
  userData = join(root, 'userData')
  workspace = join(root, 'workspace')
  catalog = new SkillCatalogService(userData)
  resolver = new DefaultManagedSkillWriteResolver(
    new SkillInstallationStore(catalog.globalSkillsRoot()),
    catalog,
  )
  events = []
  broker = new ApprovalBroker((event) => events.push(event))
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('ManagedSkillWriteResolver', () => {
  it('只接受精确 ASCII 逻辑 URI 与 1..64 KiB 正文', async () => {
    expect(await resolver.resolve('C:\\work\\SKILL.md', 'x', 's1')).toBeUndefined()
    for (const uri of [
      'daweige-skill://global/a%2fescape/SKILL.md',
      'daweige-skill://global/a%5cescape/SKILL.md',
      'daweige-skill://global/../SKILL.md',
      'daweige-skill://global/a//SKILL.md',
      'daweige-skill://global/a/SKILL.md?x=1',
      'daweige-skill://global/a/SKILL.md#x',
      'daweige-skill://global/a/extra/SKILL.md',
      'daweige-skill://global/ａ/SKILL.md',
    ]) {
      await expect(resolver.resolve(uri, markdown('a'), 's1')).rejects.toThrow(/格式不合法/)
    }
    await expect(resolver.resolve('daweige-skill://global/a/SKILL.md', '', 's1')).rejects.toThrow(/1\.\.64 KiB/)
    await expect(resolver.resolve('daweige-skill://global/a/SKILL.md', 'x'.repeat(64 * 1024 + 1), 's1'))
      .rejects.toThrow(/1\.\.64 KiB/)
    await expect(resolver.resolve('daweige-skill://global/a/SKILL.md', '# 没有 frontmatter', 's1'))
      .rejects.toThrow(/name/)
    await expect(resolver.resolve(
      'daweige-skill://global/a/SKILL.md',
      markdown('a', '## 步骤\n\n1. 运行 python ./do.py\n'),
      's1',
    )).rejects.toThrow(/脚本|程序/)
  })

  it('取消零落盘；批准写 authored marker、刷新 catalog，结果只含逻辑 URI', async () => {
    const path = 'daweige-skill://global/my-checklist/SKILL.md'
    const content = markdown('my-checklist', '## 步骤\n\n1. 使用 sk-12345678901234567890 核对\n')
    const policy = new PathPolicy(workspace, userData)
    const gate = createApprovalGate({ broker, sessionId: 's1', policy, managedSkillWrite: resolver })

    const cancelled = gate(ctx(path, content))
    const cancelCard = await waitForCard()
    expect(cancelCard.contentPreview).not.toContain('sk-12345678901234567890')
    expect(cancelCard.samplePaths).toEqual([path])
    broker.resolve({ approvalId: cancelCard.id, decision: 'reject' })
    expect(await cancelled).toEqual({ block: true, reason: expect.any(String) })
    await expect(stat(join(catalog.globalSkillsRoot(), 'my-checklist'))).rejects.toThrow()

    events = []
    const approved = gate(ctx(path, content))
    const card = await waitForCard()
    broker.resolve({ approvalId: card.id, decision: 'approve' })
    expect(await approved).toBeUndefined()
    const tool = createWriteFileTool({
      ops: new FileOps(policy), trash: async () => {}, managedSkillWrite: resolver, sessionId: 's1',
    })
    const result = await tool.execute('tc', { path, content })
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(`${path}`)
    expect(JSON.stringify(result)).not.toContain(userData)
    expect(await readFile(join(catalog.globalSkillsRoot(), 'my-checklist', '.daweige-source.json'), 'utf8'))
      .toContain('"kind": "authored"')
    expect((await catalog.list()).skills.find((skill) => skill.name === 'my-checklist')?.provenance.kind)
      .toBe('authored')
  })

  it('同名 built-in/manual/authored 均在弹卡前拒绝，技能 WRITE 不吃 session grant', async () => {
    const policy = new PathPolicy(workspace, userData)
    const gate = createApprovalGate({ broker, sessionId: 's1', policy, managedSkillWrite: resolver })
    const firstPath = 'daweige-skill://global/first-skill/SKILL.md'
    const first = gate(ctx(firstPath, markdown('first-skill')))
    const firstCard = await waitForCard()
    broker.resolve({ approvalId: firstCard.id, decision: 'approve-session' })
    expect(await first).toBeUndefined()
    expect(broker.hasSessionGrant('s1', 'write_file')).toBe(false)
    const tool = createWriteFileTool({
      ops: new FileOps(policy), trash: async () => {}, managedSkillWrite: resolver, sessionId: 's1',
    })
    await tool.execute('tc-first', { path: firstPath, content: markdown('first-skill') })

    events = []
    expect(await gate(ctx(firstPath, markdown('first-skill'))))
      .toEqual({ block: true, reason: expect.stringContaining('同名技能已经存在') })
    expect(events).toHaveLength(0)

    events = []
    const second = gate(ctx('daweige-skill://global/second-skill/SKILL.md', markdown('second-skill')))
    const secondCard = await waitForCard()
    expect(secondCard.contentPreview).toContain('name: second-skill')
    broker.resolve({ approvalId: secondCard.id, decision: 'reject' })
    await second
  })
})

function ctx(path: string, content: string): BeforeToolCallContext {
  return { toolCall: { name: 'write_file', id: 'tc-managed' }, args: { path, content } } as BeforeToolCallContext
}

async function waitForCard() {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    const event = events.find((item) => item.type === 'approval_required')
    if (event?.type === 'approval_required' && event.request.kind === 'write') return event.request
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待技能 WRITE 卡超时')
}
