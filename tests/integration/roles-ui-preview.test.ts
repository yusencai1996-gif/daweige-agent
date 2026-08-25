// 前端线自检脚本:驱动 dev 预览(MockBridge 种数据)过任务书重点场景。
// 需先启动 `npm run dev:renderer`(5199);默认跳过,用 DAWEIGE_UI_PREVIEW=1 显式开启。
import { describe, it, beforeAll, afterAll } from 'vitest'
import { chromium, expect, type Browser, type Page } from '@playwright/test'

const BASE = 'http://localhost:5199'
const RUN = process.env.DAWEIGE_UI_PREVIEW === '1'

let browser: Browser
let page: Page

beforeAll(async () => {
  if (!RUN) return
  browser = await chromium.launch({ channel: 'chromium' })
  page = await browser.newPage()
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
})

afterAll(async () => {
  await browser?.close()
})

describe.skipIf(!RUN)('0.2.0 角色化前端自检(MockBridge)', () => {
  it('场景7/8:侧栏角色卡;legacy 无新会话入口;mount missing 警示', async () => {
    // A-13 起聊天区气泡名也会显示角色名,这里只看侧栏角色卡
    await expect(page.locator('.role-card .role-name', { hasText: '小编' })).toBeVisible()
    await expect(page.getByText('账房', { exact: true })).toBeVisible()
    // 归档角色不在主列表
    await expect(page.getByText('旧管家', { exact: true })).toHaveCount(0)
    // 归档入口计数:归档角色1 + 独立归档会话1 = 2
    await expect(page.getByRole('button', { name: /归档 2/ })).toBeVisible()
    // mount missing 警示图标
    await expect(page.getByTitle('工作文件夹不见了,历史会话仍可看')).toBeVisible()
    // bootstrap 恢复了 lastActiveSessionId(demo-session-1,属小编)→ 小编卡自动展开
    await expect(page.locator('.session-item', { hasText: '整理下载文件夹' })).toBeVisible()
    // legacy 角色:展开后无「新会话」,有辅助说明,能开历史会话(手风琴:点开它会收起小编)
    await page.getByText('未找到文件夹的旧会话 (a1b2)', { exact: true }).click()
    await expect(page.getByText('找不到文件夹前的旧对话')).toBeVisible()
    await expect(page.getByText('未找到文件夹的旧会话', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /新会话/ })).toHaveCount(0)
  })

  it('场景A-12:草稿按会话隔离——A打字→切B为空→切回A恢复→发送清空', async () => {
    // 小编的会话 demo-session-1(bootstrap 已恢复为活跃);小编卡在场景7/8 被手风琴收起,先展开再点开
    await page.locator('.role-card-title', { hasText: '小编' }).click()
    await page
      .locator('.session-item', { hasText: '整理下载文件夹' })
      .click({ position: { x: 12, y: 10 } })
    const composer = page.getByLabel('输入要它干的活')
    await expect(composer).toBeEnabled()
    await composer.fill('A会话的草稿别丢')

    // 切到 legacy 会话:输入框应为空;在 B 也留一份草稿
    await page.getByText('未找到文件夹的旧会话 (a1b2)', { exact: true }).click()
    await page
      .locator('.session-item', { hasText: '找不到文件夹前的旧对话' })
      .click({ position: { x: 12, y: 10 } })
    await expect(composer).toHaveValue('')
    await composer.fill('B会话的草稿')

    // 切回 A:草稿原样恢复
    await page.locator('.role-card-title', { hasText: '小编' }).click()
    await page
      .locator('.session-item', { hasText: '整理下载文件夹' })
      .click({ position: { x: 12, y: 10 } })
    await expect(composer).toHaveValue('A会话的草稿别丢')

    // 发送清空:Enter 发出后当前槽清空,内容进消息流
    await composer.press('Enter')
    await expect(composer).toHaveValue('')
    await expect(page.getByText('A会话的草稿别丢')).toBeVisible()

    // B 槽不受影响;再切回 A 确认发送后槽已清
    await page.getByText('未找到文件夹的旧会话 (a1b2)', { exact: true }).click()
    await page
      .locator('.session-item', { hasText: '找不到文件夹前的旧对话' })
      .click({ position: { x: 12, y: 10 } })
    await expect(composer).toHaveValue('B会话的草稿')
    await page.locator('.role-card-title', { hasText: '小编' }).click()
    await page
      .locator('.session-item', { hasText: '整理下载文件夹' })
      .click({ position: { x: 12, y: 10 } })
    await expect(composer).toHaveValue('')
  })

  it('场景1:三步向导走完→新角色上墙展开;不自动建会话', async () => {
    await page.getByRole('button', { name: '＋ 新建角色' }).click()
    await page.getByPlaceholder('比如:小编、账房、文件管家').fill('小记')
    await page.getByRole('button', { name: '下一步' }).click()
    await page.getByRole('button', { name: '选择文件夹…' }).click()
    await expect(page.getByText('测试工作区', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '下一步' }).click()
    await page.getByRole('button', { name: /记事本/ }).click()
    await expect(page.getByLabel('角色守则')).toHaveValue(/# 角色守则/)
    await page.getByRole('button', { name: '招他入伙' }).click()
    // 新角色上墙 + 展开 + 空角色引导
    await expect(page.getByText('小记', { exact: true })).toBeVisible()
    await expect(page.getByText('这位伙伴还没开工')).toBeVisible()
    await expect(page.getByRole('button', { name: '和他聊聊' })).toBeVisible()
  })

  it('场景2:角色下建会话→聊天区;删除当前会话→聊天区清空', async () => {
    await page.getByRole('button', { name: '和他聊聊' }).click()
    await expect(page.getByText('这还是个空会话。')).toBeVisible()
    // 新会话出现在小记卡下
    const row = page.locator('.session-item', { hasText: '新会话' })
    await expect(row).toBeVisible()
    // 删除:hover 行 → ⋯ → 菜单「删除」→ 行内二次确认
    await row.hover({ position: { x: 8, y: 8 } })
    await page.getByRole('button', { name: '「新会话」的会话操作' }).click()
    await page.getByRole('menuitem', { name: '删除' }).click()
    await page.getByRole('button', { name: '删掉' }).click()
    await expect(page.getByText('这位伙伴还没开工')).toBeVisible()
  })

  it('场景6:守则编辑加载/保存;归档角色恢复;会话归档恢复', async () => {
    // 小编卡操作菜单 → 编辑守则
    const card = page.locator('.role-card', { hasText: '小编' })
    await card.getByRole('button', { name: '「小编」的操作' }).click()
    await page.getByRole('menuitem', { name: '编辑守则' }).click()
    await expect(page.getByText('保存后,从下一条消息开始生效')).toBeVisible()
    const textarea = page.getByLabel('角色守则')
    await expect(textarea).toHaveValue(/你是小编/)
    await textarea.fill('# 角色守则\n\n## 身份\n你是小编,守则已改。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('守则已更新', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '‹ 返回' }).click()

    // 归档区:角色页签恢复旧管家;会话页签恢复 demo-session-2
    await page.getByRole('button', { name: /归档 \d/ }).click()
    await expect(page.getByText('旧管家')).toBeVisible()
    await page.getByRole('tab', { name: /会话/ }).click()
    await expect(page.getByText('去年的旧稿')).toBeVisible()
    await page.getByRole('button', { name: '恢复' }).click() // 恢复会话
    // 从归档区消失(恢复后回到侧栏小编卡,所以只查归档区)
    await expect(page.locator('.archive-pane').getByText('去年的旧稿')).toHaveCount(0)
    await page.getByRole('tab', { name: /角色/ }).click()
    await page.getByRole('button', { name: '恢复' }).click() // 恢复旧管家
    await expect(page.getByText('没有归档的角色')).toBeVisible()
    await page.getByRole('button', { name: '‹ 返回' }).click()
    // 恢复的会话回到小编卡
    await expect(page.getByText('去年的旧稿')).toBeVisible()
    await expect(page.getByText('旧管家', { exact: true })).toBeVisible()
  })

  it('场景5:删除角色影响清单→输名确认→成功', async () => {
    const card = page.locator('.role-card', { hasText: '旧管家' })
    await card.getByRole('button', { name: '「旧管家」的操作' }).click()
    await page.getByRole('menuitem', { name: '删除' }).click()
    await expect(page.getByText('会话正文和角色守则会永久删除;使用统计保留。')).toBeVisible()
    const confirm = page.getByLabel(/输入完整角色名/)
    const delBtn = page.getByRole('button', { name: '彻底删除' })
    await expect(delBtn).toBeDisabled()
    await confirm.fill('旧管家')
    await expect(delBtn).toBeEnabled()
    await delBtn.click()
    await expect(page.getByText('旧管家', { exact: true })).toHaveCount(0)
  })

  it('场景3:会话归档→主列表消失→提示条', async () => {
    // 打开小编的会话再归档(小编卡若收起先点开)
    const sessRow = page.locator('.session-item', { hasText: '整理下载文件夹' })
    if (!(await sessRow.isVisible().catch(() => false))) {
      await page.locator('.role-card-title', { hasText: '小编' }).click()
    }
    await sessRow.click({ position: { x: 12, y: 10 } })
    const row = page.locator('.session-item', { hasText: '整理下载文件夹' })
    // hover 行 → ⋯ → 菜单「归档」
    await row.hover({ position: { x: 8, y: 8 } })
    await page.getByRole('button', { name: '「整理下载文件夹」的会话操作' }).click()
    await page.getByRole('menuitem', { name: '归档' }).click()
    // 主列表消失(标题栏里还留着当前会话名,只看侧栏行)
    await expect(page.locator('.session-item', { hasText: '整理下载文件夹' })).toHaveCount(0)
    // 聊天区顶部归档弱提示
    await expect(page.getByText(/该会话已归档/)).toBeVisible()
  })

  it('场景A-13:AI 名字跟角色走——小编会话气泡名「小编」,legacy 会话显示其角色名', async () => {
    // 场景3 之后聊天区停在已归档的「整理下载文件夹」(角色:小编),消息保留可回看
    await expect(page.locator('.msg-role').first()).toHaveText('小编')

    // 切到 legacy 会话发一条消息:回复气泡的名字应是 legacy 角色名,不再是小柊
    await page.getByText('未找到文件夹的旧会话 (a1b2)', { exact: true }).click()
    await page
      .locator('.session-item', { hasText: '找不到文件夹前的旧对话' })
      .click({ position: { x: 12, y: 10 } })
    const composer = page.getByLabel('输入要它干的活')
    await composer.fill('打个招呼')
    await composer.press('Enter')
    await expect(
      page.locator('.msg-role', { hasText: '未找到文件夹的旧会话 (a1b2)' }).first(),
    ).toBeVisible()
  })

  it('场景A-10:设置页拉模型列表→下拉选中→回写 modelId→顶部切换跟随;失败回退有弱提示', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()

    // Kimi(演示数据已配置 key):拉列表 → 固定单项下拉
    await page.getByRole('button', { name: '获取模型列表' }).click()
    const kimiSelect = page.getByLabel('Kimi 模型')
    await expect(kimiSelect).toBeVisible()
    await expect(kimiSelect.locator('option')).toHaveText(['kimi-for-coding · 26 万上下文 · 默认'])

    // GLM(国内):未填 key 时按钮禁用;填 key 保存后可拉
    await page.getByRole('tab', { name: 'GLM(国内)' }).click()
    await expect(page.getByRole('button', { name: '获取模型列表' })).toBeDisabled()
    await page.getByLabel('填入 key').fill('sk-demo-glm-cn')
    await page.getByRole('button', { name: '保存 key' }).click()
    await page.getByRole('button', { name: '获取模型列表' }).click()
    const glmSelect = page.getByLabel('GLM(国内) 模型')
    await expect(glmSelect).toBeVisible()
    await expect(glmSelect.locator('option')).toHaveText([
      'glm-4.7 · 20 万上下文 · 默认',
      'glm-4.7-air · 13 万上下文',
      'glm-4.7-flashx · 上下文未知',
    ])

    // 选中 online 模型 → 立刻写回 settings.providerSelection.modelId
    await glmSelect.selectOption('glm-4.7-air')
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const mock = (
            globalThis as unknown as {
              __daweigeMock: { calls: { channel: string; payload: unknown }[] }
            }
          ).__daweigeMock
          const call = [...mock.calls]
            .reverse()
            .find((c) => c.channel === 'settings:update')
          return (call?.payload as { settings: { providerSelection: { modelId: string } } } | undefined)
            ?.settings.providerSelection.modelId
        }),
      )
      .toBe('glm-4.7-air')

    // 回聊天:输入框工具行的模型切换跟随(tooltip 带完整模型名)
    await page.getByRole('button', { name: '← 回到聊天' }).click()
    await expect(page.locator('#provider-select')).toHaveAttribute('title', /glm-4\.7-air/)

    // DeepSeek:演示在线拉取失败回退默认列表 → notice 弱提示
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'DeepSeek' }).click()
    await page.getByLabel('填入 key').fill('sk-demo-deepseek')
    await page.getByRole('button', { name: '保存 key' }).click()
    await page.getByRole('button', { name: '获取模型列表' }).click()
    await expect(page.getByText('在线拉取失败,先显示默认列表')).toBeVisible()
    await expect(page.getByLabel('DeepSeek 模型').locator('option')).toHaveText([
      'deepseek-v4-flash · 100 万上下文 · 默认',
    ])
    await page.getByRole('button', { name: '← 回到聊天' }).click()
  })

  it('场景9:760px 抽屉态', async () => {
    await page.setViewportSize({ width: 700, height: 800 })
    const sidebar = page.locator('aside.sidebar')
    await expect(sidebar).not.toHaveClass(/open/)
    // 抽屉机制:窄屏下 transform 移出视口
    await page.waitForTimeout(300)
    const transform = (await sidebar.evaluate(
      'getComputedStyle(document.querySelector("aside.sidebar")).transform',
    )) as string
    expect(transform).not.toBe('none')
    await page.setViewportSize({ width: 1280, height: 840 })
  })
})
