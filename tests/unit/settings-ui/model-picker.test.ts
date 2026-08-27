// A-10:设置页模型选择——拉列表(credential:listModels)→ 清单勾选/选当前 → 回写 settings。
// 链路用 MockBridge 驱动;清单文案用 react-dom/server 静态渲染核对(勾选态/「当前」「默认」角标)。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MockBridge } from '../../helpers/mock-bridge'
import {
  ENABLED_MODELS_MAX,
  buildModelOptions,
  effectiveEnabledModels,
  formatContextWindow,
  modelOptionLabel,
  toggleEnabledModel,
  withProviderSelection,
} from '../../../src/renderer/features/settings/model-options'
import { ModelCheckboxList } from '../../../src/renderer/features/settings/ModelPicker'
import type { ProviderSelection, Settings } from '../../../src/shared/domain'

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

describe('toggleEnabledModel(启用池勾选)', () => {
  it('老数据无池(undefined)→ 首次勾选写入第一项', () => {
    const next = toggleEnabledModel(baseSettings, { providerId: 'zai-coding-cn', modelId: 'glm-5.3' })
    expect(next.enabledModels).toEqual([
      { providerId: 'zai-coding-cn', modelId: 'glm-5.3' },
    ])
    // 其余字段原样保留
    expect(next.providerSelection).toEqual(baseSettings.providerSelection)
  })

  it('已在池中再点一次 → 移出;旧数据里的重复条目一并清干净', () => {
    const dirty: Settings = {
      ...baseSettings,
      enabledModels: [
        { providerId: 'zai-coding-cn', modelId: 'glm-5.3' },
        { providerId: 'zai-coding-cn', modelId: 'glm-5.3' },
        { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      ],
    }
    const next = toggleEnabledModel(dirty, { providerId: 'zai-coding-cn', modelId: 'glm-5.3' })
    expect(next.enabledModels).toEqual([{ providerId: 'deepseek', modelId: 'deepseek-v4-flash' }])
  })

  it('勾选同一厂商+模型不会写出重复条目', () => {
    const once = toggleEnabledModel(baseSettings, { providerId: 'deepseek', modelId: 'v4' })
    const next = toggleEnabledModel(once, { providerId: 'deepseek', modelId: 'v4' })
    // 第二次是取消勾选:同一条目不存在两份
    expect(next.enabledModels).toEqual([])
  })

  it(`池满 ${ENABLED_MODELS_MAX} 项时返回原 settings 不变(引用相等,不发徒劳 IPC)`, () => {
    const full: Settings = {
      ...baseSettings,
      enabledModels: Array.from({ length: ENABLED_MODELS_MAX }, (_, i) => ({
        providerId: 'deepseek' as const,
        modelId: `model-${i}`,
      })),
    }
    const next = toggleEnabledModel(full, { providerId: 'deepseek', modelId: 'one-more' })
    expect(next).toBe(full)
  })
})

describe('effectiveEnabledModels(生效池回退)', () => {
  it('undefined(老数据)/空数组 → 回退为只剩当前 providerSelection 一项', () => {
    const fallback: readonly ProviderSelection[] = [baseSettings.providerSelection]
    expect(effectiveEnabledModels(baseSettings)).toEqual(fallback)
    expect(effectiveEnabledModels({ ...baseSettings, enabledModels: [] })).toEqual(fallback)
  })

  it('池里有货 → 原样返回,不掺当前项', () => {
    const pool: readonly ProviderSelection[] = [
      { providerId: 'zai-coding-cn', modelId: 'glm-5.3' },
      { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    ]
    expect(effectiveEnabledModels({ ...baseSettings, enabledModels: pool })).toEqual(pool)
  })
})

describe('ModelCheckboxList 静态渲染', () => {
  it('清单渲染:池内项勾上、当前行加粗标「当前」、catalog 行带「默认」角标', () => {
    const html = renderToStaticMarkup(
      createElement(ModelCheckboxList, {
        options: buildModelOptions(
          [
            { id: 'glm-4.7', contextWindow: 204800, source: 'catalog' },
            { id: 'glm-4.7-air', contextWindow: 131072, source: 'catalog' },
            { id: 'glm-4.7-flashx', source: 'online' },
          ],
          'glm-4.7',
        ),
        providerId: 'zai-coding-cn',
        currentModelId: 'glm-4.7',
        currentLive: true,
        enabledModels: [{ providerId: 'zai-coding-cn', modelId: 'glm-4.7-flashx' }],
        ariaLabel: 'GLM(国内) 模型',
        onChoose: () => undefined,
        onToggle: () => undefined,
      }),
    )
    // 勾选框语义=进出启用池:只有池内那项带 checked
    expect(html).toContain('aria-label="启用模型 glm-4.7-flashx"')
    expect(html).toContain('checked=""')
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3)
    // 点名字语义=设为当前使用;当前行加粗并挂「当前」角标,catalog 未在当前行的挂「默认」
    expect(html).toContain('title="把回复换成 glm-4.7"')
    expect(html).toContain('class="model-check-item current"')
    expect(html).toContain('>当前</span>')
    expect(html).toContain('>默认</span>')
    expect(html).toContain('aria-label="GLM(国内) 模型"')
  })

  it('整改:全局当前挂别家时(currentLive=false)本面板不标「当前」,默认模型只标「默认」', () => {
    const html = renderToStaticMarkup(
      createElement(ModelCheckboxList, {
        options: buildModelOptions([{ id: 'glm-4.7', source: 'catalog' }], 'glm-4.7'),
        providerId: 'zai-coding-cn',
        currentModelId: 'glm-4.7',
        currentLive: false,
        enabledModels: [],
        ariaLabel: 'GLM(国内) 模型',
        onChoose: () => undefined,
        onToggle: () => undefined,
      }),
    )
    expect(html).not.toContain('>当前</span>')
    expect(html).not.toContain('model-check-item current')
    expect(html).toContain('>默认</span>')
  })

  it('池满时未入池项的勾选框禁用,已入池仍可取消', () => {
    const html = renderToStaticMarkup(
      createElement(ModelCheckboxList, {
        options: buildModelOptions([{ id: 'glm-4.7', source: 'catalog' }], 'glm-4.7'),
        providerId: 'zai-coding-cn',
        currentModelId: 'glm-4.7',
        currentLive: true,
        enabledModels: Array.from({ length: ENABLED_MODELS_MAX }, (_, i) => ({
          providerId: 'deepseek' as const,
          modelId: `model-${i}`,
        })),
        ariaLabel: 'GLM(国内) 模型',
        onChoose: () => undefined,
        onToggle: () => undefined,
      }),
    )
    expect(html).toContain('disabled=""')
    expect(html).toContain('启用池最多 32 个')
  })
})

describe('A-10 链路:拉列表 → 选当前/勾池 → 回写(MockBridge)', () => {
  it('listModels 返回选项 → 设为当前 online 模型 → settings:update 写回 providerSelection.modelId', async () => {
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

    // 2. 点名字把第二项(online 模型)设为当前
    const chosen = options[1]!
    expect(chosen.id).toBe('glm-4.7-air')

    // 3. 与 controller.selectProvider 同一条 withProviderSelection + settings:update 路径
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

  it('勾选一个常用模型 → settings:update 带上 enabledModels(与 controller.toggleEnabledModel 同路径)', async () => {
    const bridge = new MockBridge()
    bridge.handle('settings:update', ({ settings }) => settings)

    const next = toggleEnabledModel(baseSettings, { providerId: 'kimi-coding', modelId: 'kimi-for-coding' })
    const saved = await bridge.invoke('settings:update', { settings: next })
    expect(saved.enabledModels).toEqual([
      { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
    ])
    const call = bridge.calls[0]!.payload as { settings: Settings }
    expect(call.settings.enabledModels).toHaveLength(1)
  })
})
