import { describe, expect, it } from 'vitest'
import type { Settings } from '../../../src/shared/domain/settings'
import {
  isEnabledModel,
  pruneRoleModelDefaults,
  resolveRoleModel,
  sameModel,
  withRoleModelDefault,
} from '../../../src/shared/domain/model-selection'

const globalModel = { providerId: 'kimi-coding', modelId: 'kimi-for-coding' } as const
const roleModel = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' } as const
const roleId = 'agent-a1b2c3d4e5f6'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { providerSelection: globalModel, enabledModels: [globalModel, roleModel], ...overrides }
}

describe('model-selection', () => {
  it('角色覆盖命中启用池', () => {
    const resolved = resolveRoleModel(settings({ roleModelDefaults: { [roleId]: roleModel } }), roleId)
    expect(resolved).toEqual({ selection: roleModel, source: 'role' })
  })

  it('角色缺省回退全局', () => {
    expect(resolveRoleModel(settings(), roleId)).toEqual({ selection: globalModel, source: 'global' })
  })

  it('角色模型移出池后剪枝并回退全局', () => {
    const input = settings({ enabledModels: [globalModel], roleModelDefaults: { [roleId]: roleModel } })
    expect(resolveRoleModel(input, roleId)).toEqual({ selection: globalModel, source: 'global' })
    expect(pruneRoleModelDefaults(input).roleModelDefaults).toBeUndefined()
  })

  it('空池老数据只允许全局默认', () => {
    const input = settings({ enabledModels: [], roleModelDefaults: { [roleId]: roleModel } })
    expect(isEnabledModel(input, globalModel)).toBe(true)
    expect(isEnabledModel(input, roleModel)).toBe(false)
    expect(resolveRoleModel(input, roleId)).toEqual({ selection: globalModel, source: 'global' })
  })

  it('全局不在显式池时使用池首项 fallback', () => {
    expect(resolveRoleModel(settings({ enabledModels: [roleModel] }), roleId))
      .toEqual({ selection: roleModel, source: 'fallback' })
  })

  it('设置、清除角色默认且比较模型按 provider/model', () => {
    const added = withRoleModelDefault(settings(), roleId, roleModel)
    expect(added.roleModelDefaults?.[roleId]).toEqual(roleModel)
    expect(withRoleModelDefault(added, roleId, null).roleModelDefaults).toBeUndefined()
    expect(sameModel(globalModel, { ...globalModel })).toBe(true)
  })
})
