import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRepository } from '../../../src/main/storage/session-repository'
import { SessionService } from '../../../src/main/storage/session-service'
import { createRoleFixture, type RoleFixture } from '../helpers/role-fixture'

/**
 * M2-05 验证标准:创建会话、追加多角色消息、关闭仓库、重新打开、恢复当前分支消息。
 * 跑真实 node:sqlite(本机 Node 26;打包内 Electron 43/Node 24 由 M2-05 打包测试覆盖)。
 */

let dir: string
let roleFx: RoleFixture

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daweige-sessions-'))
  roleFx = await createRoleFixture()
})

afterEach(async () => {
  roleFx.close()
  await rm(roleFx.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  // Windows 下 sqlite WAL 句柄释放有延迟,带重试;仍失败则留给系统临时目录清理
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
}, 20_000)

function userMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'kimi-coding',
    model: 'kimi-for-coding',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

describe('SessionRepository + SessionService(真实 SQLite)', () => {
  it('创建 → 列表 → 追加消息 → 关闭 → 重开 → 恢复消息(验收 11 底层)', async () => {
    const db = join(dir, 'data', 'sessions.sqlite')
    const repo = new SessionRepository(db)
    const service = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)

    // 创建
    const created = await service.create({
      roleId: roleFx.roleId,
      providerId: 'kimi-coding',
      modelId: 'kimi-for-coding',
    })
    expect(created.summary.workspacePath).toBe(roleFx.workspaceDir)
    expect(created.summary.title).toBe('新会话')

    // 直接用 pi Session 追加多角色消息(消息映射在 M3-04,这里验证底层持久化)
    const meta = await repo.list()
    expect(meta).toHaveLength(1)
    const session = await repo.open(meta[0]!)
    await session.appendMessage(userMessage('把图片按月份归档'))
    await session.appendMessage(assistantMessage('好的,我来处理'))
    await session.setName('整理图片')

    // 关闭仓库(模拟退出)
    await repo.close()

    // 重新打开(模拟重启)
    const repo2 = new SessionRepository(db)
    const service2 = new SessionService(repo2)
    const summaries = await service2.listSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.title).toBe('整理图片')
    expect(summaries[0]!.providerId).toBe('kimi-coding')

    const reopened = await meta2Session(repo2, summaries[0]!.id)
    const entries = await reopened.findEntriesOnBranch({ order: 'oldestFirst' })
    const messages = entries.filter((e) => e.type === 'message')
    expect(messages.length).toBeGreaterThanOrEqual(2)

    // stats 反映消息数
    const stats = await reopened.getStats()
    expect(stats.messageCount).toBeGreaterThanOrEqual(2)

    await repo2.close()
  })

  it('删除会话后列表为空(幂等重复删除)', async () => {
    const db = join(dir, 'data', 'sessions.sqlite')
    const repo = new SessionRepository(db)
    const service = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)

    const created = await service.create({
      roleId: roleFx.roleId,
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
    })
    expect((await service.listSummaries())).toHaveLength(1)

    await service.remove(created.summary.id)
    await service.remove(created.summary.id) // 幂等
    expect(await service.listSummaries()).toHaveLength(0)

    await repo.close()
  })

  it('多会话排序:最近更新的在前', async () => {
    const repo = new SessionRepository(join(dir, 'data', 'sessions.sqlite'))
    const service = new SessionService(repo, roleFx.roleRepository, roleFx.roleService)
    await service.create({ roleId: roleFx.roleId, providerId: 'kimi-coding', modelId: 'm' })
    await service.create({ roleId: roleFx.roleId, providerId: 'deepseek', modelId: 'm' })
    const list = await service.listSummaries()
    expect(list).toHaveLength(2)
    expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt)
    await repo.close()
  })
})

function meta2Session(repo: SessionRepository, id: string) {
  return (async () => {
    const metas = await repo.list()
    const meta = metas.find((m) => m.id === id)
    if (!meta) throw new Error(`找不到会话 ${id}`)
    return repo.open(meta)
  })()
}
