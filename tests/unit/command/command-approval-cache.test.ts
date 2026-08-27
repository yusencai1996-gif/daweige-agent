import { beforeEach, describe, expect, it } from 'vitest'
import { CommandApprovalCache } from '../../../src/main/command/command-approval-cache'

const key = (over: Partial<Parameters<CommandApprovalCache['hasSessionGrant']>[0]> = {}) => ({
  ownerSessionId: 'sess-A',
  command: 'python summarize.py',
  realCwd: 'D:\\work',
  timeoutMs: 120_000,
  sandboxLevel: 'restricted-token',
  writableRoots: ['D:\\work'],
  scopeId: '',
  ...over,
})

let cache: CommandApprovalCache

beforeEach(() => {
  cache = new CommandApprovalCache()
})

describe('CommandApprovalCache turn 粘性', () => {
  it('同 turn 完全相同命令复用;下一 turn 再弹', () => {
    cache.beginTurn('turn-1')
    cache.recordDecision('turn-1', key(), 'approve')
    expect(cache.hasTurnGrant('turn-1', key())).toBe(true)

    cache.beginTurn('turn-2')
    expect(cache.hasTurnGrant('turn-2', key())).toBe(false)
  })

  it('endTurn 清粘性', () => {
    cache.beginTurn('turn-1')
    cache.recordDecision('turn-1', key(), 'approve')
    cache.endTurn('turn-1')
    expect(cache.hasTurnGrant('turn-1', key())).toBe(false)
  })

  it('命令/cwd/timeout/写根任一变化都不复用', () => {
    cache.beginTurn('turn-1')
    cache.recordDecision('turn-1', key(), 'approve')
    expect(cache.hasTurnGrant('turn-1', key({ command: 'python summarize2.py' }))).toBe(false)
    expect(cache.hasTurnGrant('turn-1', key({ realCwd: 'D:\\other' }))).toBe(false)
    expect(cache.hasTurnGrant('turn-1', key({ timeoutMs: 60_000 }))).toBe(false)
    expect(cache.hasTurnGrant('turn-1', key({ writableRoots: ['D:\\other'] }))).toBe(false)
  })

  it('命令只差一个空格也不复用(精确匹配,无前缀放宽)', () => {
    cache.beginTurn('turn-1')
    cache.recordDecision('turn-1', key(), 'approve')
    expect(cache.hasTurnGrant('turn-1', key({ command: 'python  summarize.py' }))).toBe(false)
  })
})

describe('CommandApprovalCache session 档', () => {
  it('approve-session 同会话相同命令免卡;其他会话不吃', () => {
    cache.beginTurn('t')
    cache.recordDecision('t', key(), 'approve-session')
    expect(cache.hasSessionGrant(key())).toBe(true)
    expect(cache.hasSessionGrant(key({ ownerSessionId: 'sess-B' }))).toBe(false)
  })

  it('普通 approve 不写 session 档', () => {
    cache.beginTurn('t')
    cache.recordDecision('t', key(), 'approve')
    expect(cache.hasSessionGrant(key())).toBe(false)
  })

  it('reject 不写任何档', () => {
    cache.beginTurn('t')
    cache.recordDecision('t', key(), 'reject')
    expect(cache.hasSessionGrant(key())).toBe(false)
    expect(cache.hasTurnGrant('t', key())).toBe(false)
  })

  it('clearSession 清该 owner(会话删除/结束)', () => {
    cache.beginTurn('t')
    cache.recordDecision('t', key(), 'approve-session')
    cache.clearSession('sess-A')
    expect(cache.hasSessionGrant(key())).toBe(false)
  })

  it('invalidateScope 清 run 终态/迁移代数对应的条目', () => {
    const runKey = key({ ownerSessionId: 'internal-1', scopeId: 'run-abc' })
    cache.beginTurn('t')
    cache.recordDecision('t', runKey, 'approve-session')
    expect(cache.hasSessionGrant(runKey)).toBe(true)
    cache.invalidateScope('run-abc')
    expect(cache.hasSessionGrant(runKey)).toBe(false)
  })

  it('写根数组顺序不影响键(排序归一)', () => {
    cache.beginTurn('t')
    cache.recordDecision('t', key({ writableRoots: ['D:\\b', 'D:\\a'] }), 'approve-session')
    expect(cache.hasSessionGrant(key({ writableRoots: ['D:\\a', 'D:\\b'] }))).toBe(true)
  })
})
