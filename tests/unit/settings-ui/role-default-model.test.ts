// A-24:「存为该角色默认」可用性纯函数 + 角色默认模型面板静态渲染。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canSaveAsRoleDefault } from '../../../src/renderer/features/settings/model-options'
import { RoleDefaultModelPanel } from '../../../src/renderer/features/settings/RoleDefaultModelPanel'
import type {
  ProviderInfo,
  ProviderSelection,
  RoleSummary,
  Settings,
} from '../../../src/shared/domain'

const kimi: ProviderSelection = { providerId: 'kimi-coding', modelId: 'kimi-for-coding' }
const glm: ProviderSelection = { providerId: 'zai-coding-cn', modelId: 'glm-4.7' }
const ds: ProviderSelection = { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }

const baseSettings: Settings = {
  providerSelection: kimi,
  enabledModels: [kimi, glm],
  windowBounds: { width: 1280, height: 840, maximized: false },
}

function role(id: string, displayName: string, archivedAt: number | null): RoleSummary {
  return {
    id,
    kind: id === 'sys-xiaozhen' ? 'manager' : 'worker',
    displayName,
    templateId: 'writer',
    mounts: [],
    archivedAt,
    lifecycle: 'ready',
    createdAt: 1,
    updatedAt: 1,
    sessionCount: 0,
    activeSessionCount: 0,
  }
}

const providers: ProviderInfo[] = [
  {
    id: 'kimi-coding',
    displayName: 'Kimi',
    defaultModelId: 'kimi-for-coding',
    description: '',
    supportsThinking: true,
    contextWindow: 262144,
  },
  {
    id: 'zai-coding-cn',
    displayName: 'GLM(国内)',
    defaultModelId: 'glm-4.7',
    description: '',
    supportsThinking: true,
    contextWindow: 1_000_000,
  },
]

describe('canSaveAsRoleDefault', () => {
  it('无角色会话不可存;选择在显式启用池才可存', () => {
    expect(canSaveAsRoleDefault(baseSettings, null, kimi)).toBe(false)
    expect(canSaveAsRoleDefault(baseSettings, 'agent-a1b2c3d4e5f6', glm)).toBe(true)
    expect(canSaveAsRoleDefault(baseSettings, 'sys-xiaozhen', kimi)).toBe(true)
  })

  it('选择不在显式启用池:不可存(即便它是全局默认)', () => {
    expect(canSaveAsRoleDefault(baseSettings, 'agent-a1b2c3d4e5f6', ds)).toBe(false)
    // 老数据空池:只允许全局默认发消息,但角色默认必须引用显式池,故不可存
    const legacy: Settings = { providerSelection: kimi }
    expect(canSaveAsRoleDefault(legacy, 'agent-a1b2c3d4e5f6', kimi)).toBe(false)
  })
})

describe('RoleDefaultModelPanel', () => {
  const roles = [
    role('sys-xiaozhen', '小柊', null),
    role('agent-a1b2c3d4e5f6', '小编', null),
    role('agent-c3d4e5f6a7b8', '旧管家', 123), // 已归档:不出现在面板
  ]

  it('列出未归档角色+小柊,已归档不出现;每行都有「跟随全局」', () => {
    const html = renderToStaticMarkup(
      createElement(RoleDefaultModelPanel, {
        roles,
        enabledModels: [kimi, glm],
        roleModelDefaults: undefined,
        providers,
        onSetRoleDefault: () => {},
      }),
    )
    expect(html).toContain('角色默认模型')
    expect(html).toContain('小柊')
    expect(html).toContain('小编')
    expect(html).not.toContain('旧管家')
    // 两行各一个「跟随全局」选项
    expect(html.match(/跟随全局/g)?.length).toBe(2)
    expect(html).toContain('kimi-for-coding')
    expect(html).toContain('glm-4.7')
  })

  it('已有映射且在池:该角色选中对应模型', () => {
    const html = renderToStaticMarkup(
      createElement(RoleDefaultModelPanel, {
        roles,
        enabledModels: [kimi, glm],
        roleModelDefaults: { 'agent-a1b2c3d4e5f6': glm },
        providers,
        onSetRoleDefault: () => {},
      }),
    )
    // React SSR 会把 select 的 value 落到匹配 option 的 selected 属性上(在 value 之后)
    expect(html).toContain('value="zai-coding-cn::glm-4.7" selected=""')
  })

  it('映射引用已出池的模型:回退显示「跟随全局」', () => {
    const html = renderToStaticMarkup(
      createElement(RoleDefaultModelPanel, {
        roles,
        enabledModels: [kimi, glm],
        roleModelDefaults: { 'agent-a1b2c3d4e5f6': ds },
        providers,
        onSetRoleDefault: () => {},
      }),
    )
    expect(html).not.toContain('value="deepseek::deepseek-v4-flash" selected=""')
    expect(html.match(/value="" selected=""/g)?.length).toBe(2)
  })

  it('启用池为空:引导先去勾选,不出角色列表', () => {
    const html = renderToStaticMarkup(
      createElement(RoleDefaultModelPanel, {
        roles,
        enabledModels: [],
        roleModelDefaults: undefined,
        providers,
        onSetRoleDefault: () => {},
      }),
    )
    expect(html).toContain('先在上方模型清单里勾选常用模型')
    expect(html).not.toContain('跟随全局')
  })
})
