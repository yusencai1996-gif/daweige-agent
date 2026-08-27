import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '../../shared/domain/settings'
import type { SettingsStore } from '../storage/settings-store'
import { systemManagerWorkspacePath } from '../roles/system-manager'

/** 总管工作区不可用(配置的覆盖目录丢失/不是目录)。fail-closed,不静默回落默认。 */
export class ManagerWorkspaceUnavailableError extends Error {
  constructor(readonly configuredPath: string) {
    super('小柊的工作文件夹目前不可用(可能被移动或删除);请到设置页重新选择或恢复默认')
    this.name = 'ManagerWorkspaceUnavailableError'
  }
}

/**
 * 小柊(总管)工作区唯一解析入口——0.4.0 A(A-14)。
 * 所有需要 manager 工作区路径的代码都必须经过这里,不再直接拼 userData 默认路径。
 * 覆盖路径丢失时 fail-closed 抛错:绝不静默回落默认路径,
 * 否则用户不知情的情况下文件会被写回 C 盘,违背"不占 C 盘"的需求初衷。
 */
export class ManagerWorkspaceResolver {
  constructor(
    private readonly userDataPath: string,
    private readonly settingsStore: SettingsStore,
  ) {}

  /** 内置默认路径(userData 下)。 */
  defaultPath(): string {
    return systemManagerWorkspacePath(this.userDataPath)
  }

  /** 当前配置的覆盖路径(同步,不校验存在性;无覆盖=undefined)。 */
  configuredOverride(settings?: Settings): string | undefined {
    const current = settings ?? this.settingsStore.current()
    return current?.managerWorkspacePath
  }

  /** 展示用路径(同步,不校验):配置值或默认值。列表/卡片显示用它,绝不抛错。 */
  resolveForDisplay(): string {
    return this.configuredOverride() ?? this.defaultPath()
  }

  /** 当前是否仍为内置默认。 */
  isDefault(): boolean {
    return this.configuredOverride() === undefined
  }

  /**
   * 严格解析(创建会话/发消息/迁移校验前用):
   * 有覆盖时校验目录真实存在,丢失/非目录抛 ManagerWorkspaceUnavailableError。
   */
  async resolve(): Promise<string> {
    const override = this.configuredOverride()
    if (override === undefined) return this.defaultPath()
    let info
    try {
      info = await stat(override)
    } catch {
      throw new ManagerWorkspaceUnavailableError(override)
    }
    if (!info.isDirectory()) {
      throw new ManagerWorkspaceUnavailableError(override)
    }
    return override
  }

  /** 迁移目标的父目录命名空间(用于嵌套互斥校验)。 */
  defaultHomeParent(): string {
    return join(this.userDataPath, 'daweige')
  }
}
