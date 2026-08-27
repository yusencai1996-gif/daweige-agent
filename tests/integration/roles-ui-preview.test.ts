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
    // A-13 起聊天区气泡名也会显示角色名,这里只看侧栏角色卡(批2a 起消息流里的派活卡也带角色名,须锁定侧栏范围)
    await expect(page.locator('.role-card .role-name', { hasText: '小编' })).toBeVisible()
    await expect(page.locator('aside.sidebar').getByText('账房', { exact: true })).toBeVisible()
    // 归档角色不在主列表
    await expect(page.getByText('旧管家', { exact: true })).toHaveCount(0)
    // 归档入口计数:归档角色1 + 独立归档会话1 = 2
    await expect(page.getByRole('button', { name: /归档 2/ })).toBeVisible()
    // mount missing 警示图标
    await expect(page.getByTitle('工作文件夹不见了,历史会话仍可看')).toBeVisible()
    // 0.3.0(PLAN §4.4):bootstrap 优先打开总管入口会话(高于 lastActiveSessionId)→ 小柊卡自动展开
    await expect(page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })).toBeVisible()
    // 点开小编卡:demo-session-1 挂在其下
    await page.locator('.role-card-title', { hasText: '小编' }).click()
    await expect(page.locator('.session-item', { hasText: '整理下载文件夹' })).toBeVisible()
    // legacy 角色:展开后无「新会话」,有辅助说明,能开历史会话(手风琴:点开它会收起小编)
    await page.getByText('未找到文件夹的旧会话 (a1b2)', { exact: true }).click()
    await expect(page.getByText('找不到文件夹前的旧对话')).toBeVisible()
    await expect(page.getByText('未找到文件夹的旧会话', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /新会话/ })).toHaveCount(0)
  })

  it('场景10(0.3.0 批2a):小柊会话的三张派活卡;确认/查看过程走对应 IPC', { timeout: 20_000 }, async () => {
    // 点开小柊会话(bootstrap 已默认打开;前面场景的手风琴可能把小柊卡收起了,先确保展开)
    const mgrSession = page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })
    if (!(await mgrSession.isVisible().catch(() => false))) {
      await page.locator('.manager-card .role-card-title').click()
    }
    await mgrSession.click({ position: { x: 12, y: 10 } })

    // 三态卡渲染:completed / awaiting / interrupted
    const completed = page.locator('.delegation-card', { hasText: '账房干完了' })
    const awaiting = page.locator('.delegation-card', { hasText: '要不要派给小编' })
    await expect(completed).toBeVisible()
    await expect(awaiting).toBeVisible()
    await expect(page.locator('.delegation-card', { hasText: '已中断' })).toBeVisible()
    // 固定字段:任务简报/允许路径;interrupted 卡显示中断原因
    await expect(page.locator('.delegation-card', { hasText: '应用上次在派活中途退出' })).toBeVisible()

    // awaiting 卡点[同意派出] → approval:respond(approve);run 卡原位变「正在干活」
    const callsOf = (channel: string) =>
      page.evaluate(
        (ch) =>
          (globalThis as unknown as { __daweigeMock: { calls: { channel: string; payload: unknown }[] } })
            .__daweigeMock.calls.filter((c) => c.channel === ch)
            .map((c) => c.payload as Record<string, unknown>),
        channel,
      )
    await awaiting.getByRole('button', { name: '同意派出' }).click()
    await expect
      .poll(async () => (await callsOf('approval:respond')).map((p) => p.approvalId))
      .toContain('approval-demo-delegation')
    await expect(page.locator('.delegation-card', { hasText: '小编正在干活' })).toBeVisible()

    // completed 卡:结论摘要自动取回(agentRun:getDetail)
    await expect(completed).toContainText('南山店')

    // 批 2b(PLAN §10.3):[查看完整过程] 升级为整页只读详情,替换批 2a 的卡内内联展开
    await completed.getByRole('button', { name: '查看完整过程' }).click()
    await expect
      .poll(async () => (await callsOf('agentRun:getDetail')).map((p) => p.runId))
      .toContain('run-a1b2c3d4e5f60718')
    // 整页:返回小柊 + 角色名/状态/用量 + childSession 过程消息/工具行;不渲染 Composer
    await expect(page.getByRole('button', { name: '‹ 返回小柊' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '账房的干活过程' })).toBeVisible()
    await expect(page.getByText('账房干完了')).toBeVisible()
    await expect(page.getByText(/轮次 6 · 总 token/)).toBeVisible()
    await expect(page.getByText(/汇总完了:3 家门店总额/)).toBeVisible()
    await expect(page.getByText('读取 3 家门店的月度销售表')).toBeVisible()
    await expect(page.getByLabel('输入要它干的活')).toHaveCount(0)
    // 返回小柊:回到聊天,派活卡仍在
    await page.getByRole('button', { name: '‹ 返回小柊' }).click()
    await expect(completed).toBeVisible()
    await expect(page.getByLabel('输入要它干的活')).toBeVisible()
  })

  it('场景10b(0.3.0 批2b):守则草稿卡——好块成卡/坏块留文本;不亲手保存不发写 IPC', async () => {
    const callsOf = (channel: string) =>
      page.evaluate(
        (ch) =>
          (globalThis as unknown as { __daweigeMock: { calls: { channel: string; payload: unknown }[] } })
            .__daweigeMock.calls.filter((c) => c.channel === ch)
            .map((c) => c.payload as Record<string, unknown>),
        channel,
      )
    // 场景10 结尾已回到小柊会话;两张好块卡 + 一个坏块(普通代码文本)
    await expect(page.locator('.draft-card')).toHaveCount(2)
    await expect(page.locator('.msg-text', { hasText: '坏掉的草稿' })).toBeVisible()

    // 新角色草稿卡:「用这个草稿建角色」→ 向导打开,名字/守则已预填;取消不发 role:create
    const newCard = page.locator('.draft-card', { hasText: '新伙伴「小账」' })
    await expect(newCard.getByText(/你是小账,管家里的收支台账/)).toBeVisible()
    await newCard.getByRole('button', { name: '用这个草稿建角色' }).click()
    await expect(page.getByRole('dialog', { name: '新建角色' })).toBeVisible()
    await expect(page.getByPlaceholder('比如:小编、账房、文件管家')).toHaveValue('小账')
    await page.getByRole('button', { name: '取消' }).click()
    expect(await callsOf('role:create')).toHaveLength(0)

    // 既有角色草稿卡:「过目并保存」→ 守则页打开并本地预填;不点保存不发 role:updateGuardrails
    const existCard = page.locator('.draft-card', { hasText: '给「小编」' })
    await existCard.getByRole('button', { name: '过目并保存' }).click()
    await expect(page.getByText('保存后,从下一条消息开始生效')).toBeVisible()
    const rulesText = page.getByLabel('角色守则')
    await expect(rulesText).toHaveValue(/成稿先给主人过目/)
    expect(await callsOf('role:updateGuardrails')).toHaveLength(0)
    // 亲手点保存才发 role:updateGuardrails(AI 绝不直接落守则文件)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('守则已更新', { exact: false })).toBeVisible()
    await expect.poll(async () => (await callsOf('role:updateGuardrails')).length).toBe(1)
    await page.getByRole('button', { name: '‹ 返回' }).click()
  })

  it('阻断-3:worker 会话里的 daweige-role-draft 块只当代码文本,不出卡、无动作按钮', async () => {
    // 场景10b 结尾停在小柊会话;点开小编的 worker 会话(小编卡先展开)
    await page.locator('.role-card-title', { hasText: '小编' }).click()
    await page
      .locator('.session-item', { hasText: '整理下载文件夹' })
      .click({ position: { x: 12, y: 10 } })
    await expect(page.getByLabel('输入要它干的活')).toBeEnabled()

    // worker 会话收到一条含 daweige-role-draft 块的助手消息(越权场景)
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      const sessionId = 'demo-session-1'
      const messageId = 'demo-worker-draft-a1'
      mock.emitAgentEvent({ type: 'message_start', sessionId, messageId, createdAt: Date.now() })
      mock.emitAgentEvent({
        type: 'text_delta',
        sessionId,
        messageId,
        delta: '我试着起了一份草稿:\n\n```daweige-role-draft\n{"displayName":"越权草稿","guardrails":"# 不该出现"}\n```\n\n你看行吗?',
      })
      mock.emitAgentEvent({ type: 'message_end', sessionId, messageId })
      mock.emitAgentEvent({ type: 'agent_end', sessionId })
    })

    // 渲染为普通代码文本:fenced 块内容在正文里,但没有任何草稿卡/动作按钮
    await expect(page.locator('.msg-text', { hasText: '越权草稿' })).toBeVisible()
    await expect(page.locator('.draft-card')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '用这个草稿建角色' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '过目并保存' })).toHaveCount(0)
  })

  it('严重-2:运行中详情页随 internal 事件防抖刷新——事件合并重拉 getDetail,过程增多', async () => {
    const callsOf = (channel: string) =>
      page.evaluate(
        (ch) =>
          (globalThis as unknown as { __daweigeMock: { calls: { channel: string; payload: unknown }[] } })
            .__daweigeMock.calls.filter((c) => c.channel === ch)
            .map((c) => c.payload as Record<string, unknown>),
        channel,
      )

    // 回小柊会话(卡若收起先展开),打开账房 completed 卡的完整过程整页
    const mgrSession = page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })
    if (!(await mgrSession.isVisible().catch(() => false))) {
      await page.locator('.manager-card .role-card-title').click()
    }
    await mgrSession.click({ position: { x: 12, y: 10 } })
    const completed = page.locator('.delegation-card', { hasText: '账房干完了' })
    await completed.getByRole('button', { name: '查看完整过程' }).click()
    await expect(page.getByRole('heading', { name: '账房的干活过程' })).toBeVisible()
    await expect(page.getByText(/汇总完了:3 家门店总额/)).toBeVisible()

    // 覆写 getDetail:每次调用多回一条过程消息(模拟主进程快照随干活推进变长)
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { handle: (channel: string, fn: (payload: { runId: string }) => unknown) => void }
        }
      ).__daweigeMock
      const w = globalThis as unknown as { __demoSyncCount: number }
      w.__demoSyncCount = 0
      mock.handle('agentRun:getDetail', ({ runId }) => {
        w.__demoSyncCount += 1
        const messages = Array.from({ length: w.__demoSyncCount }, (_, i) => ({
          kind: 'chat',
          role: 'assistant',
          id: `sync-msg-${i}`,
          text: `同步进来的过程 第${i + 1}条`,
          createdAt: Date.now(),
        }))
        return {
          run: { runId },
          envelope: {
            userRequest: '帮我把门店报表汇总一下',
            managerConclusions: [],
            taskBrief: '汇总门店销售表',
            acceptanceCriteria: ['给出总额'],
            allowedWorkspacePaths: ['D:\\门店报表'],
          },
          result: null,
          childSession: {
            summary: { id: 'demo-run-internal-1' },
            messages,
          },
          readOnly: true,
        }
      })
    })
    const detailCalls = async () => (await callsOf('agentRun:getDetail')).length
    const before = await detailCalls()

    // 密集发一串 internal 会话的 text_delta(sessionId=该 run 的 internalSessionId)
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      for (let i = 0; i < 8; i += 1) {
        mock.emitAgentEvent({
          type: 'text_delta',
          sessionId: 'demo-run-internal-1',
          messageId: 'sync-live-1',
          delta: `增量${i}`,
        })
      }
    })

    // 500ms 防抖窗口内 8 个事件合并成一次重拉;内容随之更新
    await expect(page.getByText('同步进来的过程 第1条')).toBeVisible({ timeout: 3000 })
    await expect.poll(detailCalls).toBe(before + 1)

    // 再来一个事件:窗口过后再拉一次,过程继续增多
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      mock.emitAgentEvent({
        type: 'message_end',
        sessionId: 'demo-run-internal-1',
        messageId: 'sync-live-1',
      })
    })
    await expect(page.getByText('同步进来的过程 第2条')).toBeVisible({ timeout: 3000 })
    await expect.poll(detailCalls).toBe(before + 2)

    // 返回小柊,恢复聊天页(后续场景从 manager 会话继续)
    await page.getByRole('button', { name: '‹ 返回小柊' }).click()
    await expect(completed).toBeVisible()
  })

  it('闭合复核:getDetail 慢请求在途期间的触发不丢——dirty 尾随重拉到最新版', async () => {
    const callsOf = (channel: string) =>
      page.evaluate(
        (ch) =>
          (globalThis as unknown as { __daweigeMock: { calls: { channel: string; payload: unknown }[] } })
            .__daweigeMock.calls.filter((c) => c.channel === ch)
            .map((c) => c.payload as Record<string, unknown>),
        channel,
      )
    const detailCalls = async () => (await callsOf('agentRun:getDetail')).length

    // 打开账房详情页(初始加载走上一场景的计数 handler,即时返回)
    const completed = page.locator('.delegation-card', { hasText: '账房干完了' })
    await completed.getByRole('button', { name: '查看完整过程' }).click()
    await expect(page.getByRole('heading', { name: '账房的干活过程' })).toBeVisible()

    // 覆写 getDetail:第一次调用挂起(可控 resolve),后续调用即时返回当版内容
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { handle: (channel: string, fn: (payload: { runId: string }) => unknown) => void }
        }
      ).__daweigeMock
      const w = globalThis as unknown as {
        __trailingVersion: number
        __trailingResolve: (() => void) | null
      }
      w.__trailingVersion = 0
      w.__trailingResolve = null
      const build = (version: number) => ({
        run: { runId: 'run-a1b2c3d4e5f60718' },
        envelope: {
          userRequest: '帮我把门店报表汇总一下',
          managerConclusions: [],
          taskBrief: '汇总门店销售表',
          acceptanceCriteria: ['给出总额'],
          allowedWorkspacePaths: ['D:\\门店报表'],
        },
        result: null,
        childSession: {
          summary: { id: 'demo-run-internal-1' },
          messages: [
            {
              kind: 'chat',
              role: 'assistant',
              id: `trailing-${version}`,
              text: `尾随版本 第${version}版`,
              createdAt: Date.now(),
            },
          ],
        },
        readOnly: true,
      })
      mock.handle('agentRun:getDetail', () => {
        w.__trailingVersion += 1
        const version = w.__trailingVersion
        if (version === 1) {
          // 慢请求:挂起到测试手动放行
          return new Promise((resolve) => {
            w.__trailingResolve = () => resolve(build(version))
          })
        }
        return build(version)
      })
    })
    const before = await detailCalls()

    // 第一串事件 → 500ms 防抖后发出慢请求(在途挂起)
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      mock.emitAgentEvent({
        type: 'text_delta',
        sessionId: 'demo-run-internal-1',
        messageId: 'trail-1',
        delta: 'a',
      })
    })
    await expect.poll(detailCalls, { timeout: 3000 }).toBe(before + 1)
    // 慢请求在途期间再来一串事件 → 防抖后触发 loadRunDetail,应只记 dirty 不新发请求
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      mock.emitAgentEvent({
        type: 'message_end',
        sessionId: 'demo-run-internal-1',
        messageId: 'trail-1',
      })
    })
    await page.waitForTimeout(800) // 防抖 500ms 已过了,在途去重生效
    expect(await detailCalls()).toBe(before + 1)

    // 放行慢请求:落地后 dirty 标触发尾随第二次重拉,内容刷到最新版
    await page.evaluate(() => {
      const w = globalThis as unknown as { __trailingResolve: (() => void) | null }
      w.__trailingResolve?.()
    })
    await expect.poll(detailCalls, { timeout: 3000 }).toBe(before + 2)
    await expect(page.getByText('尾随版本 第2版')).toBeVisible({ timeout: 3000 })

    // 返回小柊,恢复聊天页
    await page.getByRole('button', { name: '‹ 返回小柊' }).click()
    await expect(completed).toBeVisible()
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

  it('场景A-10(改版):设置页拉模型列表→清单勾选进池/点名字设当前→回写;失败回退有弱提示', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()

    // Kimi(演示数据已配置 key):拉列表 → 固定单行清单,kimi-for-coding 带上下文/默认信息
    await page.getByRole('button', { name: '获取模型列表' }).click()
    const kimiList = page.getByLabel('Kimi 模型')
    await expect(kimiList).toBeVisible()
    await expect(kimiList.getByText('kimi-for-coding', { exact: true })).toBeVisible()
    await expect(kimiList.getByText('26 万上下文')).toBeVisible()

    // GLM(国内):未填 key 时按钮禁用;填 key 保存后可拉
    await page.getByRole('tab', { name: 'GLM(国内)' }).click()
    await expect(page.getByRole('button', { name: '获取模型列表' })).toBeDisabled()
    await page.getByLabel('填入 key').fill('sk-demo-glm-cn')
    await page.getByRole('button', { name: '保存 key' }).click()
    await page.getByRole('button', { name: '获取模型列表' }).click()
    const glmList = page.getByLabel('GLM(国内) 模型')
    await expect(glmList.getByText('glm-4.7-flashx', { exact: true })).toBeVisible()
    await expect(glmList.getByText('13 万上下文')).toBeVisible()

    // 勾选框=进出启用池:勾上 glm-4.7-air → settings:update 带上 enabledModels
    await glmList.getByLabel('启用模型 glm-4.7-air').check()
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
          return (call?.payload as { settings: { enabledModels?: { providerId: string; modelId: string }[] } })
            ?.settings.enabledModels
        }),
      )
      .toEqual([{ providerId: 'zai-coding-cn', modelId: 'glm-4.7-air' }])

    // 点名字=设为当前使用 → 立刻写回 settings.providerSelection.modelId
    await glmList.getByText('glm-4.7-air', { exact: true }).click()
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

    // 回聊天:输入框工具行按钮显示当前模型 id(tooltip 带完整模型名)
    await page.getByRole('button', { name: '← 回到聊天' }).click()
    await expect(page.locator('#provider-select')).toHaveText(/glm-4\.7-air/)
    await expect(page.locator('#provider-select')).toHaveAttribute('title', /glm-4\.7-air/)

    // DeepSeek:演示在线拉取失败回退默认列表 → notice 弱提示
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: 'DeepSeek' }).click()
    await page.getByLabel('填入 key').fill('sk-demo-deepseek')
    await page.getByRole('button', { name: '保存 key' }).click()
    await page.getByRole('button', { name: '获取模型列表' }).click()
    await expect(page.getByText('在线拉取失败,先显示默认列表')).toBeVisible()
    const dsList = page.getByLabel('DeepSeek 模型')
    await expect(dsList.getByText('deepseek-v4-flash', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '← 回到聊天' }).click()
  })

  it('场景11(0.3.0 批2b):使用统计页派活用量区——默认折叠,展开按 run 列账,再收起', async () => {
    await page.getByRole('button', { name: '使用统计' }).click()
    await expect(page.getByRole('heading', { name: '使用统计' })).toBeVisible()
    const section = page.locator('.usage-delegations')
    await expect(section).toBeVisible()
    await expect(section).toContainText('派活用量')
    await expect(section).toContainText(/小计 .+ tokens/)
    // 默认折叠:run 行不出场
    await expect(section.getByText('汇总 D:\\门店报表 下所有门店的月度销售表,输出总额与异常行')).toHaveCount(0)
    // 展开:两条 run(账房汇总/中断的核对),一行截断带全文 title
    await section.getByRole('button', { name: '展开' }).click()
    await expect(section.getByText('汇总 D:\\门店报表 下所有门店的月度销售表,输出总额与异常行')).toBeVisible()
    await expect(section.getByText('核对上月发票与入库单')).toBeVisible()
    await expect(section.getByText(/轮次 6/)).toBeVisible()
    await expect(section.getByText(/轮次 2/)).toBeVisible()
    // 再收起:run 行消失,区块仍在
    await section.getByRole('button', { name: '收起' }).click()
    await expect(section.getByText('核对上月发票与入库单')).toHaveCount(0)
    await page.getByRole('button', { name: '‹ 返回' }).click()
  })

  it('初审-严重:usage_updated 防抖重拉 run 列表,completed 派活卡用量补齐', async () => {
    // 打开小柊会话(manager run 列表已加载)
    const mgrSession = page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })
    if (!(await mgrSession.isVisible().catch(() => false))) {
      await page.locator('.manager-card .role-card-title').click()
    }
    await mgrSession.click({ position: { x: 12, y: 10 } })
    const completed = page.locator('.delegation-card', { hasText: '账房干完了' })
    await expect(completed.getByText(/轮次 6 · 总 token/)).toBeVisible()

    // 覆写 agentRun:list:账房 run 用量变成 轮次 9(模拟 usage 晚落库后补上了账)
    await page.evaluate(async () => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: {
            invoke: (channel: string, payload: Record<string, unknown>) => Promise<
              { runId: string; usage: { rounds: number } }[]
            >
            handle: (channel: string, fn: () => unknown) => void
          }
        }
      ).__daweigeMock
      const runs = await mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' })
      const bumped = runs.map((r) =>
        r.runId === 'run-a1b2c3d4e5f60718' ? { ...r, usage: { ...r.usage, rounds: 9 } } : r,
      )
      mock.handle('agentRun:list', () => bumped)
    })

    // emit usage_updated:200ms 防抖后重拉 run 列表,卡片用量原位刷新
    await page.evaluate(() => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: { emitAgentEvent: (event: Record<string, unknown>) => void }
        }
      ).__daweigeMock
      mock.emitAgentEvent({ type: 'usage_updated', generatedAt: Date.now() })
    })
    await expect(completed.getByText(/轮次 9 · 总 token/)).toBeVisible({ timeout: 3000 })
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

  it('场景D1(0.4.0 D):协作链族谱——宽屏 DAG/窄屏单列/链摘要卡/打断确认走对应 IPC', { timeout: 20_000 }, async () => {
    const callsOf = (channel: string) =>
      page.evaluate(
        (ch) =>
          (globalThis as unknown as { __daweigeMock: { calls: { channel: string; payload: unknown }[] } })
            .__daweigeMock.calls.filter((c) => c.channel === ch)
            .map((c) => c.payload as Record<string, unknown>),
        channel,
      )

    // 打开账房 completed 卡的详情页(该卡在交棒链 graph-0123456789abcdef 上,链上有两节点)
    const mgrSession = page.locator('.manager-card .session-item', { hasText: '和小柊聊天' })
    if (!(await mgrSession.isVisible().catch(() => false))) {
      await page.locator('.manager-card .role-card-title').click()
    }
    await mgrSession.click({ position: { x: 12, y: 10 } })
    const completed = page.locator('.delegation-card', { hasText: '账房干完了' })

    // 卡头链摘要:同 graph 多节点才出;点开浮层能看到两位伙伴
    await expect(completed.getByRole('button', { name: /协作链 2 节点/ })).toBeVisible()
    await completed.getByRole('button', { name: /协作链 2 节点/ }).click()
    await expect(page.locator('.delegation-chain-pop')).toBeVisible()
    await expect(page.locator('.delegation-chain-pop')).toContainText('账房')
    await expect(page.locator('.delegation-chain-pop')).toContainText('小编')
    await completed.getByRole('button', { name: /协作链 2 节点/ }).click()
    await expect(page.locator('.delegation-chain-pop')).toHaveCount(0)

    // 详情页顶部族谱区块:getGraph 懒加载(DTO 直出摘要头)+ 宽屏 DAG
    await completed.getByRole('button', { name: '查看完整过程' }).click()
    await expect
      .poll(async () =>
        (await callsOf('agentRun:getGraph')).map(
          (p) => (p as { graphId: string }).graphId,
        ),
      )
      .toContain('graph-0123456789abcdef')
    const graphBlock = page.locator('.run-graph')
    await expect(graphBlock.getByText(/协作链/)).toBeVisible()
    await expect(graphBlock.getByText(/2 节点/)).toBeVisible()
    await expect(graphBlock.getByText(/总 token/)).toBeVisible()
    // DAG:两节点一列一层;handoff 边一条带「交棒」标
    await expect(page.locator('.run-graph-col')).toHaveCount(2)
    await expect(page.locator('.run-node', { hasText: '账房' })).toBeVisible()
    await expect(page.locator('.run-node', { hasText: '小编' })).toBeVisible()
    await expect(page.locator('.run-graph-wire.handoff')).toHaveCount(1)
    await expect(graphBlock.getByText('交棒')).toBeVisible()
    // 当前 run 高亮(朱砂聚焦):打开的是账房那条
    await expect(page.locator('.run-node.is-current', { hasText: '账房' })).toBeVisible()

    // 节点点击换到下游 run 的详情页
    await page.locator('button.run-node', { hasText: '小编' }).click()
    await expect(page.getByRole('heading', { name: '小编的干活过程' })).toBeVisible()
    await expect(page.locator('.run-node.is-current', { hasText: '小编' })).toBeVisible()

    // 窄屏(<1000px):拓扑序单列,边转「来自:账房」文字行,wires 不画线
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(page.locator('.run-graph-list')).toBeVisible()
    await expect(page.locator('.run-item-upstream', { hasText: '来自:账房(交棒)' })).toBeVisible()
    await expect(page.locator('.run-graph-wires')).toBeHidden()
    await page.setViewportSize({ width: 1280, height: 840 })

    // 返回小柊,试打断入口:终态的账房 completed 没有打断按钮;
    // mock 的 agentRun:list 重开会话会回到种子态(awaiting),先推一条 running 事件模拟主进程推进
    await page.getByRole('button', { name: '‹ 返回小柊' }).click()
    await expect(completed.getByRole('button', { name: '打断' })).toHaveCount(0)
    await page.evaluate(async () => {
      const mock = (
        globalThis as unknown as {
          __daweigeMock: {
            invoke: (
              channel: string,
              payload: Record<string, unknown>,
            ) => Promise<{ runId: string }[]>
            emitAgentEvent: (event: Record<string, unknown>) => void
          }
        }
      ).__daweigeMock
      const runs = await mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' })
      const target = runs.find((r) => r.runId === 'run-b2c3d4e5f6a70829')
      if (target) {
        mock.emitAgentEvent({
          type: 'agent_run_updated',
          managerSessionId: 'demo-session-manager',
          run: {
            ...target,
            status: 'running',
            startedAt: Date.now(),
            internalSessionId: 'demo-run-internal-2',
          },
        })
      }
    })
    const runningCard = page.locator('.delegation-card', { hasText: '小编正在干活' })
    await expect(runningCard.getByRole('button', { name: '打断' })).toBeVisible()

    // 先「先不打」:不发任何 IPC
    await runningCard.getByRole('button', { name: '打断', exact: true }).click()
    await expect(runningCard.getByText('确定打断?已完成的产出保留,未完成的不再继续')).toBeVisible()
    await runningCard.getByRole('button', { name: '先不打' }).click()
    await expect(runningCard.getByRole('button', { name: '打断', exact: true })).toBeVisible()
    expect(await callsOf('agentRun:interrupt')).toHaveLength(0)

    // 确认打断:发 agentRun:interrupt(runId + 归属会话)
    await runningCard.getByRole('button', { name: '打断', exact: true }).click()
    await runningCard.getByRole('button', { name: '确定打断' }).click()
    await expect
      .poll(async () => await callsOf('agentRun:interrupt'))
      .toEqual([{ runId: 'run-b2c3d4e5f6a70829', managerSessionId: 'demo-session-manager' }])
  })
})
