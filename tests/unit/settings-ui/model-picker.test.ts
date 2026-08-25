// A-10:设置页模型选择——拉列表(credential:listModels)→ 下拉渲染 → 选中回写 settings.providerSelection.modelId。
// 链路用 MockBridge 驱动;下拉文案用 react-dom/server 静态渲染核对(选项 id/上下文/「默认」角标)。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MockBridge } from '../../helpers/mock-bridge'
import {
  buildModelOptions,
  formatContextWindow,
  modelOptionLabel,
  withProviderSelection,
} from '../../../src/renderer/features/settings/model-options'
import { ModelSelect } from '../../../src/renderer/features/settings/ModelPicker'
import type { Settings } from '../../../src/shared/domain'

const baseSettings: Settings = {
  providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
  windowBounds: { width: 1280, height: 840, maximized: false },
}

describe('formatContextWindow / modelOptionLabel', () => {
  it('上下文窗口人话:万位取整;undefined 显示未知', () => {
    expect(formatContextWindow(262144)).toBe('26 万上下文')
    expect(formatContextWindow(1000000)).toBe('100 万上下文')
    expect(formatContextWindow(8192)).toBe('8192 上下文')
    expect(formatContextWindow(undefined)).toBe('上下文未知')
  })

  it('catalog 项标「默认」,online 项不标', () => {
    expect(modelOptionLabel({ id: 'glm-4.7', contextWindow: 204800, source: 'catalog' })).toBe(
      'glm-4.7 · 20 万上下文 · 默认',
    )
    expect(modelOptionLabel({ id: 'glm-4.7-air', source: 'online' })).toBe(
      'glm-4.7-air · 上下文未知',
    )
  })
})

describe('buildModelOptions', () => {
  it('当前选中的模型不在列表里 → 置顶补「当前」项,选中态不丢', () => {
    const options = buildModelOptions(
      [{ id: 'glm-4.7', contextWindow: 204800, source: 'catalog' }],
      'glm-4.6-old',
    )
    expect(options[0]).toMatchObject({ id: 'glm-4.6-old', current: true })
    expect(modelOptionLabel(options[0]!)).toBe('glm-4.6-old · 上下文未知 · 当前')
    expect(options).toHaveLength(2)
  })

  it('按 id 去重;当前项已在列表则不重复补', () => {
    const options = buildModelOptions(
      [
        { id: 'glm-4.7', source: 'catalog' },
        { id: 'glm-4.7', source: 'online' },
      ],
      'glm-4.7',
    )
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ id: 'glm-4.7', source: 'catalog' })
  })
})

describe('ModelSelect 静态渲染', () => {
  it('下拉渲染:每项显示 id + 上下文,catalog 带「默认」角标,选中值落在当前模型', () => {
    const html = renderToStaticMarkup(
      createElement(ModelSelect, {
        options: buildModelOptions(
          [
            { id: 'glm-4.7', contextWindow: 204800, source: 'catalog' },
            { id: 'glm-4.7-flashx', source: 'online' },
          ],
          'glm-4.7-flashx',
        ),
        value: 'glm-4.7-flashx',
        ariaLabel: 'GLM(国内) 模型',
        onChange: () => undefined,
      }),
    )
    expect(html).toContain('glm-4.7 · 20 万上下文 · 默认')
    expect(html).toContain('glm-4.7-flashx · 上下文未知')
    expect(html).toContain('aria-label="GLM(国内) 模型"')
    expect(html).toContain('value="glm-4.7-flashx"')
  })
})

describe('A-10 链路:拉列表 → 选中 → 回写 modelId(MockBridge)', () => {
  it('listModels 返回选项 → 选中 online 模型 → settings:update 写回 providerSelection.modelId', async () => {
    const bridge = new MockBridge()
    bridge.handle('credential:listModels', () => ({
      models: [
        { id: 'glm-4.7', contextWindow: 204800, source: 'catalog' as const },
        { id: 'glm-4.7-air', contextWindow: 131072, source: 'online' as const },
      ],
      notice: '在线拉取失败,先显示默认列表',
    }))
    bridge.handle('settings:update', ({ settings }) => settings)

    // 1. 拉列表(组件里当前值=该厂默认模型 glm-4.7,在列表内,不触发「当前」置顶)
    const result = await bridge.invoke('credential:listModels', { providerId: 'zai-coding-cn' })
    expect(result.notice).toBe('在线拉取失败,先显示默认列表')
    const options = buildModelOptions(result.models, 'glm-4.7')

    // 2. 模拟下拉选中第二项(online 模型)
    const chosen = options[1]!
    expect(chosen.id).toBe('glm-4.7-air')

    // 3. 选中即持久化:与 controller.selectProvider 同一条 withProviderSelection + settings:update 路径
    const next = withProviderSelection(baseSettings, {
      providerId: 'zai-coding-cn',
      modelId: chosen.id,
    })
    const saved = await bridge.invoke('settings:update', { settings: next })
    expect(saved.providerSelection).toEqual({ providerId: 'zai-coding-cn', modelId: 'glm-4.7-air' })

    // 4. 调用次序与载荷核对:先拉列表,后写设置;其余 settings 字段原样保留
    expect(bridge.calls.map((c) => c.channel)).toEqual(['credential:listModels', 'settings:update'])
    const updateCall = bridge.calls[1]!.payload as { settings: Settings }
    expect(updateCall.settings.providerSelection.modelId).toBe('glm-4.7-air')
    expect(updateCall.settings.windowBounds).toEqual(baseSettings.windowBounds)
  })
})
