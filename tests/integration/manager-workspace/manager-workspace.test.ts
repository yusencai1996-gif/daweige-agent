import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SettingsStore } from '../../../src/main/storage/settings-store'
import {
  ManagerWorkspaceResolver,
  ManagerWorkspaceUnavailableError,
} from '../../../src/main/manager-workspace/resolver'
import {
  ManagerWorkspaceMigrationError,
  ManagerWorkspaceMigrationService,
} from '../../../src/main/manager-workspace/migration-service'
import { systemManagerWorkspacePath } from '../../../src/main/roles/system-manager'

let userData: string
let settingsStore: SettingsStore
let resolver: ManagerWorkspaceResolver
let migration: ManagerWorkspaceMigrationService

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'manager-workspace-'))
  settingsStore = new SettingsStore(join(userData, 'settings.json'))
  await settingsStore.load()
  resolver = new ManagerWorkspaceResolver(userData, settingsStore)
  migration = new ManagerWorkspaceMigrationService(resolver, settingsStore)
})

afterEach(async () => {
  rmSync(userData, { recursive: true, force: true })
})

describe('ManagerWorkspaceResolver', () => {
  it('无覆盖时返回内置默认路径', async () => {
    await expect(resolver.resolve()).resolves.toBe(systemManagerWorkspacePath(userData))
    expect(resolver.isDefault()).toBe(true)
    expect(resolver.resolveForDisplay()).toBe(systemManagerWorkspacePath(userData))
  })

  it('有覆盖且目录存在时返回覆盖路径', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dwg-ws-target-'))
    try {
      await settingsStore.save({
        ...settingsStore.current()!,
        managerWorkspacePath: target,
      })
      await expect(resolver.resolve()).resolves.toBe(target)
      expect(resolver.isDefault()).toBe(false)
      expect(resolver.resolveForDisplay()).toBe(target)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('覆盖目录丢失时 fail-closed 抛人话错,展示路径仍不抛', async () => {
    const lost = join(tmpdir(), `dwg-ws-lost-${Date.now()}`)
    await settingsStore.save({
      ...settingsStore.current()!,
      managerWorkspacePath: lost,
    })
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ManagerWorkspaceUnavailableError)
    // 列表/卡片显示不受影响(显示配置值,不抛错)
    expect(resolver.resolveForDisplay()).toBe(lost)
  })
})

describe('ManagerWorkspaceMigrationService', () => {
  async function seedDefaultWorkspace(): Promise<void> {
    mkdirSync(systemManagerWorkspacePath(userData), { recursive: true })
    writeFileSync(join(systemManagerWorkspacePath(userData), 'a.txt'), 'hello 小柊')
    mkdirSync(join(systemManagerWorkspacePath(userData), 'sub'))
    writeFileSync(join(systemManagerWorkspacePath(userData), 'sub', 'b.md'), '中文内容')
  }

  it('成功迁移:文件全量到新位置+settings 生效+旧目录清理', async () => {
    await seedDefaultWorkspace()
    const target = mkdtempSync(join(tmpdir(), 'dwg-ws-migrate-ok-'))
    try {
      const state = await migration.migrate(target)
      expect(state.effectivePath).toBe(target)
      expect(state.isDefault).toBe(false)
      expect(state.restartRequired).toBe(false)
      // 新位置内容完整
      expect(existsSync(join(target, 'a.txt'))).toBe(true)
      expect(existsSync(join(target, 'sub', 'b.md'))).toBe(true)
      // settings 已切换
      expect(settingsStore.current()?.managerWorkspacePath).toBe(target)
      // 旧目录已清
      expect(existsSync(systemManagerWorkspacePath(userData))).toBe(false)
      // resolver 立即生效
      await expect(resolver.resolve()).resolves.toBe(target)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('目标非空目录:拒绝且原样不动', async () => {
    await seedDefaultWorkspace()
    const target = mkdtempSync(join(tmpdir(), 'dwg-ws-migrate-busy-'))
    writeFileSync(join(target, 'existing.txt'), '占位')
    try {
      await expect(migration.migrate(target)).rejects.toBeInstanceOf(
        ManagerWorkspaceMigrationError,
      )
      // 没提交:settings 未变,旧目录原样
      expect(settingsStore.current()?.managerWorkspacePath).toBeUndefined()
      expect(existsSync(join(systemManagerWorkspacePath(userData), 'a.txt'))).toBe(true)
      expect(existsSync(join(target, 'existing.txt'))).toBe(true)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('目标嵌套在默认 workspace 内:拒绝', async () => {
    await seedDefaultWorkspace()
    const nested = join(systemManagerWorkspacePath(userData), 'inner')
    await expect(migration.migrate(nested)).rejects.toBeInstanceOf(ManagerWorkspaceMigrationError)
    expect(settingsStore.current()?.managerWorkspacePath).toBeUndefined()
  })

  it('跨盘迁移(C 默认位置 → F 盘)不再被误拦(用户 0827 真机实踩回归)', async () => {
    if (!existsSync('F:\\')) return // 无 F 盘的机器跳过
    await seedDefaultWorkspace()
    const target = join('F:\\', `daweige-migrate-e2e-${Date.now()}`)
    try {
      // 修复前:path.relative 跨盘返回绝对路径,所有跨盘目标都被误判"在源里面"
      const state = await migration.migrate(target)
      expect(state.effectivePath).toBe(resolve(target))
      expect(settingsStore.current()?.managerWorkspacePath).toBe(resolve(target))
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('目标包含默认 workspace:拒绝', async () => {
    await seedDefaultWorkspace()
    // userData 整个目录包含默认 workspace
    await expect(migration.migrate(userData)).rejects.toBeInstanceOf(
      ManagerWorkspaceMigrationError,
    )
    expect(settingsStore.current()?.managerWorkspacePath).toBeUndefined()
  })

  it('目标=当前工作区:拒绝(无意义迁移)', async () => {
    await seedDefaultWorkspace()
    await expect(migration.migrate(systemManagerWorkspacePath(userData))).rejects.toBeInstanceOf(
      ManagerWorkspaceMigrationError,
    )
  })

  it('迁移到新位置后可再迁回默认(恢复默认对称)', async () => {
    await seedDefaultWorkspace()
    const target = mkdtempSync(join(tmpdir(), 'dwg-ws-roundtrip-'))
    try {
      await migration.migrate(target)
      expect(existsSync(join(target, 'a.txt'))).toBe(true)
      // 恢复默认:目标目录此时在默认位置不存在 → 源存在(=target)→ 拷回
      const state = await migration.migrate(systemManagerWorkspacePath(userData))
      expect(state.isDefault).toBe(true)
      expect(existsSync(join(systemManagerWorkspacePath(userData), 'a.txt'))).toBe(true)
      expect(settingsStore.current()?.managerWorkspacePath).toBeUndefined()
      // target 旧位置被清理
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('源丢失(用户手动删了默认 workspace):只建目标并提交,不报错', async () => {
    // 不 seed——默认 workspace 不存在
    const target = mkdtempSync(join(tmpdir(), 'dwg-ws-nosrc-'))
    try {
      const state = await migration.migrate(target)
      expect(state.effectivePath).toBe(target)
      expect(settingsStore.current()?.managerWorkspacePath).toBe(target)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
})

describe('settings:update 防绕过(契约层)', () => {
  it('SettingsSchema 接受可选 managerWorkspacePath 字段(类型层可达,运行时由 handler 防线拒绝)', async () => {
    // 该用例锁 schema 形状:字段可选、非必填,旧 settings 文件(无该字段)加载不炸
    expect(settingsStore.current()?.managerWorkspacePath).toBeUndefined()
    await settingsStore.save({ ...settingsStore.current()!, managerWorkspacePath: 'D:/x' })
    expect(settingsStore.current()?.managerWorkspacePath).toBe('D:/x')
  })
})
