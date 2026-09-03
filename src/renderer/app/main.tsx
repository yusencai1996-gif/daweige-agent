import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AgentRunDetail,
  AgentRunSummary,
  ChatMessage,
  InstalledSkill,
  MemoryNoteSummary,
  SessionDetail,
  SessionSummary,
} from '../../shared/domain'
import type { DaweigeBridge } from '../../shared/ipc/bridge'
import type { MockBridge } from '../../../tests/helpers/mock-bridge'
import { App } from './App'
import '../styles/global.css'
import '../styles/sidebar.css'
import '../styles/chat.css'
import '../styles/markdown.css'
import '../styles/approvals.css'
import '../styles/settings.css'
import '../styles/reminders.css'
import '../features/roles/roles.css'
import '../features/manager/manager.css'
import '../features/usage/usage.css'
// 飞白皴笔形态层(0.4.0 B1):必须最后加载,同特异性下覆盖基线样式
import '../styles/shape-tokens.css'

/**
 * 渲染进程入口。
 * 桥装配优先级:真实 preload 桥(Electron dev/生产)→ MockBridge(纯 web 预览,无 Electron 环境)。
 */
async function createBridge(): Promise<DaweigeBridge> {
  // Electron 环境(dev 与生产构建)都有 preload 暴露的真桥
  const real = window.daweige
  if (real) return real

  // 纯 web 预览(vite.renderer.config.ts,无 Electron):用 MockBridge
  if (import.meta.env.DEV) {
    const { MockBridge } = await import('../../../tests/helpers/mock-bridge')
    const mock = new MockBridge()
    wireDemoBehaviors(mock)
    window.__daweigeMock = mock
    return mock
  }
  throw new Error('窗口数据通道不可用,请重新启动应用')
}

/* ================= 以下为 DEV 演示行为(只活在开发态) ================= */

const DEMO_REPLY = `好的,我看了一下,这活儿可以这么干:

## 我的计划

1. 先扫一遍文件夹,把图片都挑出来
2. 按拍摄月份建好文件夹
3. 移动之前,把清单给你过目

| 类型 | 数量 |
| --- | --- |
| 图片 | 38 张 |
| 文档 | 12 个 |
| 其他 | 5 个 |

只是挪文件,一条命令都不用跑:

\`\`\`text
IMG_2031.jpg  →  2026-07/
IMG_2032.jpg  →  2026-07/
\`\`\`

确认一下我就动手。更多用法可以以后慢慢聊,先看[这个说明](https://example.com/daweige)也行。`

/** 把回复切成若干增量,模拟 text_delta 流。 */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

function wireDemoBehaviors(mock: MockBridge): void {
  const now = Date.now()
  let idCounter = 0
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`

  /** 总管演示会话(0.3.0):bootstrap.manager.entrySessionId 指向它,启动默认落在这条。 */
  const managerSummary: SessionSummary = {
    id: 'demo-session-manager',
    title: '和小柊聊天',
    workspacePath: '',
    roleId: 'sys-xiaozhen',
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 7_200_000,
    updatedAt: now - 600_000,
    messageCount: 6,
  }
  const managerHistory: ChatMessage[] = [
    {
      kind: 'chat',
      role: 'user',
      id: 'demo-mgr-u1',
      text: '小柊,你能帮我干什么?',
      createdAt: now - 7_000_000,
    },
    {
      kind: 'chat',
      role: 'assistant',
      id: 'demo-mgr-a1',
      text: '我是小柊,这个家的总管。简单的事我直接答;要动文件夹、多步骤的活儿,我会派给合适的伙伴去做,做完把结果拿给你过目。',
      createdAt: now - 6_900_000,
    },
    {
      kind: 'chat',
      role: 'user',
      id: 'demo-mgr-u2',
      text: '我想再招个专管记账的伙伴,你给起个草稿?',
      createdAt: now - 5_900_000,
    },
    {
      kind: 'chat',
      // 批 2b 演示(PLAN §10.5):新角色场景的好草稿块——卡片「用这个草稿建角色」预填向导
      role: 'assistant',
      id: 'demo-mgr-a2',
      text: `可以。我起了一份草稿,你先过目:

\`\`\`daweige-role-draft
{
  "displayName": "小账",
  "guardrails": "# 角色守则\\n\\n## 身份\\n你是小账,管家里的收支台账。\\n\\n## 干活方式\\n- 只在交给你的文件夹里读写\\n- 每笔记账都写清来源票据\\n\\n## 禁区\\n- 不改动历史账单原件,只新增修订记录"
}
\`\`\`

看中就点「用这个草稿建角色」:名字和守则都替你填好了,文件夹和人设你亲手选,最后你确认才算数。`,
      createdAt: now - 5_800_000,
    },
    {
      kind: 'chat',
      // 既有角色场景(targetRoleId=小编)+ 坏块演示:坏块只当普通代码文本,不出卡、不动作
      role: 'assistant',
      id: 'demo-mgr-a3',
      text: `另外给「小编」补了一条守则草稿,点「过目并保存」会在守则页填好,你看了亲手保存才生效:

\`\`\`daweige-role-draft
{"displayName":"小编","guardrails":"# 角色守则\\n\\n## 身份\\n你是小编,家里的写手。\\n\\n## 补充\\n- 成稿先给主人过目,再定稿","targetRoleId":"agent-a1b2c3d4e5f6"}
\`\`\`

顺带说一句:写坏的这种标记我只当普通文字,不会有任何动作——

\`\`\`daweige-role-draft
{ "displayName": "坏掉的草稿", "guardrails":
\`\`\``,
      createdAt: now - 5_700_000,
    },
    {
      kind: 'chat',
      // C4 演示:run_command 工具过程块(CommandBlock 刷新恢复渲染路径,带终值)
      role: 'assistant',
      id: 'demo-mgr-a4',
      text: '我先在沙箱里跑了一条只读命令,看看报表文件夹里都有什么:',
      createdAt: now - 5_650_000,
      toolExecutions: [
        {
          toolCallId: 'demo-cmd-1',
          toolName: 'run_command',
          displayName: '运行命令',
          status: 'succeeded' as const,
          summary: '列出 D:\\门店报表 的文件清单',
          command: {
            command: 'cmd /c "dir /b D:\\门店报表"',
            cwd: 'C:\\Users\\demo\\Documents\\测试工作区',
            exitCode: 0,
            durationMs: 420,
            timedOut: false,
            cancelled: false,
            stdout: '2026-06报表.xlsx\n2026-07报表.xlsx\n2026-08报表.xlsx\n汇总结果.md',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        },
      ],
    },
  ]
  const demoSummary: SessionSummary = {
    id: 'demo-session-1',
    title: '整理下载文件夹',
    workspacePath: 'C:\\Users\\demo\\Downloads',
    roleId: 'agent-a1b2c3d4e5f6',
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 3_600_000,
    updatedAt: now - 1_800_000,
    messageCount: 2,
  }
  const demoHistory: ChatMessage[] = [
    {
      kind: 'chat',
      role: 'user',
      id: 'demo-msg-u1',
      text: '帮我把下载文件夹里的图片整理一下',
      createdAt: now - 3_000_000,
    },
    {
      // A-29 演示:dev 预览里一条压缩提示行(重启恢复渲染路径,与 session:open 映射同形态)
      kind: 'compaction',
      role: 'system',
      id: 'demo-compaction-1',
      summary:
        '此前已确认:下载文件夹里共 38 张图片、12 个文档;整理方案是按拍摄月份建文件夹再移动,移动前先把清单给用户过目。用户偏好:不保留原位置副本。',
      tokensBefore: 182_400,
      tokensAfter: 3_120,
      createdAt: now - 2_995_000,
    },
    {
      kind: 'chat',
      role: 'assistant',
      id: 'demo-msg-a1',
      text: '好的。我数了一下,里面一共有 **38 张图片**。\n\n如果你想,我可以按月份给它们建好文件夹再移过去——你说一声就行。',
      createdAt: now - 2_990_000,
    },
  ]

  const summaries: SessionSummary[] = [managerSummary, demoSummary]
  const archivedSummary: SessionSummary = {
    id: 'demo-session-2',
    title: '去年的旧稿',
    workspacePath: 'C:\\Users\\demo\\Documents\\稿件',
    roleId: 'agent-a1b2c3d4e5f6',
    archivedAt: now - 86_400_000,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 8 * 86_400_000,
    updatedAt: now - 2 * 86_400_000,
    messageCount: 12,
  }
  const legacySummary: SessionSummary = {
    id: 'demo-session-legacy',
    title: '找不到文件夹前的旧对话',
    workspacePath: '',
    roleId: 'agent-e5f6a7b8c9d0',
    archivedAt: null,
    providerId: 'kimi-coding',
    modelId: 'kimi-for-coding',
    createdAt: now - 40 * 86_400_000,
    updatedAt: now - 20 * 86_400_000,
    messageCount: 1,
  }
  summaries.push(archivedSummary, legacySummary)
  const details = new Map<string, SessionDetail>([
    ['demo-session-manager', { summary: managerSummary, messages: managerHistory }],
    ['demo-session-1', { summary: demoSummary, messages: demoHistory }],
    [
      'demo-session-legacy',
      {
        summary: legacySummary,
        messages: [
          {
            kind: 'chat',
            role: 'user',
            id: 'demo-legacy-u1',
            text: '(旧对话)那时候的工作文件夹已经不在了',
            createdAt: now - 40 * 86_400_000,
          },
        ],
      },
    ],
  ])
  const timers = new Map<string, number[]>()
  const pendingApprovals = new Map<
    string,
    { sessionId: string; toolCallId: string; messageId: string }
  >()
  /** 0.7.0 A 演示:技能候选卡 → 安装预览卡两阶段(awaiting 中的审批 id → 归属会话与阶段)。 */
  const pendingSkillApprovals = new Map<string, { sessionId: string; stage: 'candidate' | 'install' }>()

  // 0.3.0 批 2a 演示:种子里那条「待确认」的派活(run-b2c3d4e5f6a70829,派给小编)
  // 补一张 delegation 确认卡事件;点[同意派出]/[不派]后演示 run 原位变状态卡。
  const demoAwaitingRun: AgentRunSummary = {
    runId: 'run-b2c3d4e5f6a70829',
    managerSessionId: 'demo-session-manager',
    targetRoleId: 'agent-a1b2c3d4e5f6',
    targetRoleName: '小编',
    internalSessionId: null,
    parentRunId: 'run-a1b2c3d4e5f60718',
    status: 'awaiting-approval',
    waitingReason: null,
    graphId: 'graph-0123456789abcdef',
    dependsOnRunIds: ['run-a1b2c3d4e5f60718'],
    queueReason: null,
    followupCount: 0,
    interruptSource: null,
    taskBrief: '把 D:\\稿件草稿 里的素材整理成一篇 800 字短文',
    allowedWorkspacePaths: ['D:\\稿件草稿'],
    usage: {
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    createdAt: now - 120_000,
    startedAt: null,
    completedAt: null,
    updatedAt: now - 120_000,
  }
  const pendingDelegations = new Map<string, AgentRunSummary>([
    ['approval-demo-delegation', demoAwaitingRun],
  ])
  /**
   * 演示 run 的最新状态(批准/拒绝后流转):agentRun:getDetail 覆写以它为准,
   * 没动过的 run 退回种子里 agentRun:list 的静态版本。
   */
  const demoRunState = new Map<string, AgentRunSummary>()
  window.setTimeout(() => {
    mock.emitAgentEvent({
      type: 'approval_required',
      sessionId: 'demo-session-manager',
      surfaceSessionId: 'demo-session-manager',
      request: {
        id: 'approval-demo-delegation',
        kind: 'delegation',
        runId: demoAwaitingRun.runId,
        targetRoleId: demoAwaitingRun.targetRoleId,
        targetRoleName: demoAwaitingRun.targetRoleName,
        taskBrief: demoAwaitingRun.taskBrief,
        allowedWorkspacePaths: demoAwaitingRun.allowedWorkspacePaths,
        acceptanceCriteria: [
          '800 字左右,超出或不足都要说一声',
          '只用素材里的事实,不虚构',
          '存为新文件,不改原始素材',
        ],
        title: '派给小编:整理 800 字短文',
        description: '小编只会在 D:\\稿件草稿 里读写,把素材整理成一篇 800 字左右的短文,存为新文件。',
        createdAt: Date.now(),
      },
    })
  }, 800)

  const schedule = (sessionId: string, fn: () => void, delay: number) => {
    const timer = window.setTimeout(fn, delay)
    const list = timers.get(sessionId) ?? []
    list.push(timer)
    timers.set(sessionId, list)
  }
  const clearTimers = (sessionId: string) => {
    for (const timer of timers.get(sessionId) ?? []) window.clearTimeout(timer)
    timers.set(sessionId, [])
  }

  mock.seedDemoState({ sessions: [...summaries] })

  // 使用统计演示数据:dev 预览直接可开「使用统计」整页;
  // 批 2b(PLAN §9.3)补上派活用量区——runs 取种子里有量的两条 run,小计与 totalTokens 对齐
  mock.handle('usage:getDashboard', async () => {
    const { demoUsageDashboard } = await import('../../../tests/helpers/mock-bridge')
    const base = demoUsageDashboard()
    const runs = await mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' })
    const billed = runs.filter((r) => r.usage.totalTokens > 0)
    return {
      ...base,
      delegations: {
        totalTokens: billed.reduce((sum, r) => sum + r.usage.totalTokens, 0),
        runs: billed,
      },
    }
  })

  /**
   * 批 2b 演示(PLAN §10.3):种子里 agentRun:getDetail 的 childSession 是空消息,
   * 这里覆写补 2~3 条过程消息,详情整页打开不空;信封/结论沿用种子演示口径。
   */
  mock.handle('agentRun:getDetail', async ({ runId }) => {
    const runs = await mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' })
    const seeded = runs.find((r) => r.runId === runId)
    const run = demoRunState.get(runId) ?? seeded
    if (!run) throw new Error(`MockBridge: 未预置派活 ${runId}`)
    const startedAt = run.startedAt ?? run.createdAt
    const childMessages: ChatMessage[] =
      run.internalSessionId === null
        ? []
        : run.status === 'interrupted'
          ? [
              {
                kind: 'chat',
                role: 'user',
                id: 'demo-run3-u1',
                text: run.taskBrief,
                createdAt: startedAt,
              },
              {
                kind: 'chat',
                role: 'assistant',
                id: 'demo-run3-a1',
                text: '收到,我先去翻上月的入库单,逐张和发票对。对到一半应用退出了,这次没自动接着干。',
                createdAt: startedAt + 30_000,
              },
            ]
          : run.runId === demoAwaitingRun.runId
            ? [
                {
                  kind: 'chat',
                  role: 'user',
                  id: 'demo-run2-u1',
                  text: run.taskBrief,
                  createdAt: startedAt,
                },
                {
                  kind: 'chat',
                  role: 'assistant',
                  id: 'demo-run2-a1',
                  text: '好,我先看看 D:\\稿件草稿 里都有哪些素材,再搭 800 字短文的架子。',
                  createdAt: startedAt + 15_000,
                },
              ]
            : [
                {
                  kind: 'chat',
                  role: 'user',
                  id: 'demo-run1-u1',
                  text: run.taskBrief,
                  createdAt: startedAt,
                },
                {
                  kind: 'chat',
                  role: 'assistant',
                  id: 'demo-run1-a1',
                  text: '好的,我先把 D:\\门店报表 下各门店的月度销售表都读出来。',
                  createdAt: startedAt + 20_000,
                  toolExecutions: [
                    {
                      toolCallId: 'demo-run1-tool1',
                      toolName: 'read_files',
                      displayName: '读取文件',
                      status: 'succeeded' as const,
                      summary: '读取 3 家门店的月度销售表',
                    },
                  ],
                },
                {
                  kind: 'chat',
                  role: 'assistant',
                  id: 'demo-run1-a2',
                  text: '汇总完了:3 家门店总额 ¥20,370;南山店有一笔异常折让,我已经把明细写进 D:\\门店报表\\汇总结果.md。',
                  createdAt: startedAt + 90_000,
                },
              ]
    const detail: AgentRunDetail = {
      run,
      envelope: {
        userRequest: '帮我把门店报表汇总一下,列出有异常的行',
        managerConclusions: ['报表在 D:\\门店报表', '需要总额和异常行两项'],
        taskBrief: run.taskBrief,
        acceptanceCriteria: ['给出总额', '列出异常行', '结果保存为新文件'],
        allowedWorkspacePaths: run.allowedWorkspacePaths,
      },
      result:
        run.status === 'completed'
          ? {
              summary: '已汇总 3 家门店,总额 ¥20,370;发现南山店一笔异常折让。',
              conclusions: ['城中店 ¥7,850', '东门店 ¥6,700', '南山店 ¥5,820'],
              artifactPaths: ['D:\\门店报表\\汇总结果.md'],
              unmetCriteria: [],
              boundaryViolations: [],
            }
          : null,
      childSession:
        run.internalSessionId === null
          ? null
          : {
              summary: {
                id: run.internalSessionId,
                title: `派活过程:${run.targetRoleName}`,
                workspacePath: run.allowedWorkspacePaths[0] ?? '',
                roleId: run.targetRoleId,
                archivedAt: null,
                providerId: 'kimi-coding',
                modelId: 'kimi-for-coding',
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                messageCount: childMessages.length,
              },
              messages: childMessages,
            },
      readOnly: true,
    }
    return detail
  })

  /**
   * A-28 演示:list 也合并 demoRunState——批准后的状态流转在切会话重进时不倒退
   * (invoke 在覆写前调用,拿到的是种子静态版;之后再走本覆写)。
   */
  const seededRunsPromise = Promise.resolve(
    mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' }),
  )
  mock.handle('agentRun:list', async ({ managerSessionId }) => {
    const base = await seededRunsPromise
    return base
      .filter((r) => r.managerSessionId === managerSessionId)
      .map((r) => demoRunState.get(r.runId) ?? r)
  })

  /**
   * A-28 演示:面板显示的链图按 graphId 取;种子 getGraph 读静态 demoRuns,
   * 批准演示 run 后状态留在 demoRunState——这里覆写合并,面板上节点状态跟事件走。
   */
  mock.handle('agentRun:getGraph', async ({ graphId, managerSessionId }) => {
    const runs = await mock.invoke('agentRun:list', { managerSessionId: 'demo-session-manager' })
    const nodes = runs
      .filter((r) => r.graphId === graphId)
      .map((r) => demoRunState.get(r.runId) ?? r)
    if (nodes.length === 0) throw new Error(`MockBridge: 未预置协作链 ${graphId}`)
    if (nodes.some((n) => n.managerSessionId !== managerSessionId)) {
      throw new Error('MockBridge: 协作链不属于该总管会话')
    }
    const edges =
      graphId === 'graph-0123456789abcdef'
        ? [{ fromRunId: 'run-a1b2c3d4e5f60718', toRunId: 'run-b2c3d4e5f6a70829', kind: 'handoff' as const }]
        : []
    return {
      graphId,
      managerSessionId,
      nodes,
      edges,
      aggregate: {
        active: nodes.filter((n) => ['awaiting-approval', 'queued', 'running', 'waiting'].includes(n.status)).length,
        completed: nodes.filter((n) => n.status === 'completed').length,
        failed: nodes.filter((n) => n.status === 'failed' || n.status === 'rejected').length,
        interrupted: nodes.filter((n) => n.status === 'interrupted').length,
        totalTokens: nodes.reduce((sum, n) => sum + n.usage.totalTokens, 0),
      },
    }
  })

  mock.handle('session:list', () => summaries)
  mock.handle('session:open', ({ sessionId }) => {
    const detail = details.get(sessionId)
    if (!detail) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    return detail
  })
  mock.handle('session:create', ({ roleId }) => {
    const selection = { providerId: 'kimi-coding', modelId: 'kimi-for-coding' } as const
    const createdAt = Date.now()
    const summary: SessionSummary = {
      id: nextId('session'),
      title: '新会话',
      // 总管会话固定系统私有 cwd,演示数据里留空;worker 会话才带演示工作目录
      workspacePath: roleId === 'sys-xiaozhen' ? '' : 'C:\\Users\\demo\\Downloads',
      roleId,
      archivedAt: null,
      providerId: selection.providerId,
      modelId: selection.modelId,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
    }
    const detail: SessionDetail = { summary, messages: [] }
    summaries.unshift(summary)
    details.set(summary.id, detail)
    return detail
  })
  mock.handle('session:rename', ({ sessionId, title }) => {
    const index = summaries.findIndex((s) => s.id === sessionId)
    const found = index >= 0 ? summaries[index] : undefined
    if (!found) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    const renamed: SessionSummary = { ...found, title, updatedAt: Date.now() }
    summaries[index] = renamed
    const detail = details.get(sessionId)
    if (detail) details.set(sessionId, { ...detail, summary: renamed })
    return renamed
  })
  mock.handle('session:delete', ({ sessionId }) => {
    const index = summaries.findIndex((s) => s.id === sessionId)
    if (index >= 0) summaries.splice(index, 1)
    details.delete(sessionId)
    clearTimers(sessionId)
    return undefined
  })

  mock.handle('credential:save', ({ providerId, apiKey }) => {
    const tail = apiKey.slice(-4)
    return {
      providerId,
      configured: true as const,
      maskedKey: `sk-****${tail === '' ? 'demo' : tail}`,
    }
  })
  mock.handle('credential:test', () => ({
    ok: true,
    message: '连接正常,当前模型 kimi-for-coding',
  }))

  // 记忆管理演示数据:0.7.0 分页契约,dev 预览可真实演练查看/删除/清空
  let memoryRevision = 3
  const demoMemoryEntries: MemoryNoteSummary[] = [
    {
      id: '2026-08-29T09-15-00-mama-shengri.md',
      content: '我妈生日是三月五号',
      title: '妈妈生日',
      category: '生日',
      date: { kind: 'recurring', month: 3, day: 5 },
      createdAt: now - 86_400_000,
      source: { kind: 'conversation', roleId: 'sys-xiaozhen', roleDisplayName: '小柊' },
    },
    {
      id: '2026-08-28T20-40-00-jiehun-jinian.md',
      content: '和老婆结婚纪念日是 2020 年 10 月 1 日',
      title: '结婚纪念日',
      category: '纪念日',
      date: { kind: 'recurring', month: 10, day: 1 },
      createdAt: now - 2 * 86_400_000,
      source: { kind: 'conversation', roleId: 'agent-a1b2c3d4e5f6', roleDisplayName: '小编' },
    },
    {
      id: '2026-08-27T08-05-00-chezi-nianjian.md',
      content: '2026-09-01 车子要年检',
      title: '车子年检',
      category: '待办',
      date: { kind: 'fixed', iso: '2026-09-01' },
      createdAt: now - 3 * 86_400_000,
      source: { kind: 'life-note-migration', legacyId: 'demo-mem-3' },
    },
    {
      id: '2026-08-26T07-30-00-hecha-pianhao.md',
      content: '我喜欢喝淡一点的茶',
      title: '喝茶偏好',
      category: '偏好',
      createdAt: now - 4 * 86_400_000,
      source: { kind: 'life-note-migration', legacyId: 'demo-mem-4' },
    },
    {
      // 长中文内容:验证窄窗折行不破版
      id: '2026-08-25T18-20-00-chufang-zhengli.md',
      content:
        '厨房抽屉里那包没拆封的龙井是去年朋友从杭州带回来的,保质期到年底;岳母嘱咐过好茶要先紧着客人喝,自己平时喝普通的就行,别忘了先把旧茶喝完再拆新的。',
      createdAt: now - 5 * 86_400_000,
      source: { kind: 'conversation', roleId: 'sys-xiaozhen', roleDisplayName: '小柊' },
    },
  ]
  mock.handle('memory:list', ({ cursor, limit = 50 }) => {
    const offset = cursor === undefined ? 0 : Number(cursor.replace('demo:', ''))
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0
    const entries = demoMemoryEntries.slice(safeOffset, safeOffset + limit)
    const nextOffset = safeOffset + entries.length
    return {
      revision: memoryRevision,
      mergeState: 'clean' as const,
      entries,
      ...(nextOffset < demoMemoryEntries.length ? { nextCursor: `demo:${nextOffset}` } : {}),
      total: demoMemoryEntries.length,
      reset: false,
    }
  })
  mock.handle('memory:delete', ({ memoryId }) => {
    const index = demoMemoryEntries.findIndex((m) => m.id === memoryId)
    if (index < 0) return { deleted: false, revision: memoryRevision, mergeState: 'clean' as const }
    demoMemoryEntries.splice(index, 1)
    memoryRevision += 1
    return { deleted: true, revision: memoryRevision, mergeState: 'pending' as const }
  })
  mock.handle('memory:clear', () => {
    const deletedCount = demoMemoryEntries.length
    demoMemoryEntries.length = 0
    if (deletedCount > 0) memoryRevision += 1
    return {
      deletedCount,
      revision: memoryRevision,
      mergeState: deletedCount > 0 ? 'pending' as const : 'clean' as const,
    }
  })

  // 技能演示数据(0.6.0 F1;0.7.0 A3 补 market/manual 来源行):全局一组+两个角色各一组+一条诊断,刷新可见 generation 变化
  let skillGeneration = 2
  const demoSkills: InstalledSkill[] = [
    {
      id: 'global:weekly-menu',
      name: 'weekly-menu',
      description: '按家里口味和冰箱存货排一周菜谱,顺带列出要补买的菜。',
      source: { kind: 'global' },
      builtIn: false,
      logicalLocation: 'daweige-skill://global/weekly-menu/SKILL.md',
      provenance: { kind: 'authored' },
      canUninstall: true,
    },
    {
      // 0.7.0 A3 演示:内置精选来源(元信息齐全)
      id: 'global:files-and-photos-organize',
      name: 'files-and-photos-organize',
      description: '按类型和日期整理散乱文件,执行前先给出方案。',
      source: { kind: 'global' },
      builtIn: false,
      logicalLocation: 'daweige-skill://global/files-and-photos-organize/SKILL.md',
      provenance: {
        kind: 'market',
        registryId: 'curated',
        registryName: '内置精选',
        slug: 'files-and-photos-organize',
        owner: 'daweige',
        version: '1.0.0',
        license: 'MIT',
        installedAt: now - 2 * 86_400_000,
      },
      canUninstall: true,
    },
    {
      // 0.7.0 A3 演示:GitHub 来源(缺 version/license,元信息按缺失省略)
      id: 'global:meeting-notes-to-action-items',
      name: 'meeting-notes-to-action-items',
      description: '把散乱会议纪要整理成带负责人和截止时间的行动清单。',
      source: { kind: 'global' },
      builtIn: false,
      logicalLocation: 'daweige-skill://global/meeting-notes-to-action-items/SKILL.md',
      provenance: {
        kind: 'market',
        registryId: 'github',
        registryName: 'GitHub',
        slug: 'meeting-notes-to-action-items',
        owner: 'agent-skills-community',
        installedAt: now - 86_400_000,
      },
      canUninstall: true,
    },
    {
      // 0.7.0 A3 演示:手动放进文件夹的技能(自装,不可由设置页卸载)
      id: 'global:my-packing-list',
      name: 'my-packing-list',
      description: '自己写的出行行李清单模板,直接从文件夹放进去的。',
      source: { kind: 'global' },
      builtIn: false,
      logicalLocation: 'daweige-skill://global/my-packing-list/SKILL.md',
      provenance: { kind: 'manual' },
      canUninstall: false,
    },
    {
      id: 'role:sys-xiaozhen:delegation-breakdown',
      name: 'delegation-breakdown',
      description: '把大活拆成小步派给合适的伙伴:先定目标,再列验收标准,最后盯结果。',
      source: { kind: 'role', roleId: 'sys-xiaozhen', roleDisplayName: '小柊' },
      builtIn: true,
      logicalLocation: 'daweige-skill://role/sys-xiaozhen/delegation-breakdown/SKILL.md',
      provenance: { kind: 'built-in' },
      canUninstall: false,
    },
    {
      id: 'role:agent-a1b2c3d4e5f6:work-report-writing',
      name: 'work-report-writing',
      description:
        '工作汇报写法:先结论后过程,数字要有出处,段落之间留气口;周报、月报、项目总结都按这个路子走,篇幅长的时候先搭骨架再填肉。',
      source: { kind: 'role', roleId: 'agent-a1b2c3d4e5f6', roleDisplayName: '小编' },
      builtIn: true,
      logicalLocation: 'daweige-skill://role/agent-a1b2c3d4e5f6/work-report-writing/SKILL.md',
      provenance: { kind: 'built-in' },
      canUninstall: false,
    },
    {
      id: 'role:agent-b2c3d4e5f6a7:multi-sheet-reconcile',
      name: 'multi-sheet-reconcile',
      description: '多张表格对账:先读预览摸清列结构,逐表核对后再汇总,异常行单独列出来。',
      source: { kind: 'role', roleId: 'agent-b2c3d4e5f6a7', roleDisplayName: '账房' },
      builtIn: true,
      logicalLocation: 'daweige-skill://role/agent-b2c3d4e5f6a7/multi-sheet-reconcile/SKILL.md',
      provenance: { kind: 'built-in' },
      canUninstall: false,
    },
  ]
  const demoSkillSnapshot = () => ({
    generation: skillGeneration,
    skills: demoSkills,
    diagnostics: [
      {
        code: 'parse_failed' as const,
        message: '技能「随手记模板」的开头信息写坏了,已跳过;修好格式后点「刷新」再试。',
        source: { kind: 'global' as const },
        relativePath: 'broken-note/SKILL.md',
      },
    ],
    effectiveFrom: 'new-session' as const,
  })
  mock.handle('skill:list', () => demoSkillSnapshot())
  mock.handle('skill:refresh', () => {
    skillGeneration += 1
    return demoSkillSnapshot()
  })
  mock.handle('skill:uninstall', ({ skillId, expectedGeneration }) => {
    if (expectedGeneration !== skillGeneration) throw new Error('技能列表已经变化,请刷新后重试')
    const index = demoSkills.findIndex((skill) => skill.id === skillId && skill.canUninstall)
    if (index < 0) throw new Error('这个技能不能由设置页卸载')
    demoSkills.splice(index, 1)
    skillGeneration += 1
    return demoSkillSnapshot()
  })
  mock.handle('skill:openFolder', () => undefined)

  mock.handle('message:abort', ({ sessionId }) => {
    clearTimers(sessionId)
    mock.emitAgentEvent({ type: 'agent_end', sessionId })
    return undefined
  })

  mock.handle('approval:respond', ({ approvalId, decision }) => {
    // 0.7.0 A 演示:候选卡批准 → 紧跟安装预览卡(超长截断正文);安装卡批准 → 收尾一句话
    const skillPending = pendingSkillApprovals.get(approvalId)
    if (skillPending) {
      pendingSkillApprovals.delete(approvalId)
      const { sessionId, stage } = skillPending
      schedule(
        sessionId,
        () =>
          mock.emitAgentEvent({
            type: 'approval_resolved',
            sessionId,
            approvalId,
            decision: decision === 'reject' ? 'reject' : 'approve',
          }),
        200,
      )
      if (decision !== 'reject') {
        if (stage === 'candidate') {
          schedule(
            sessionId,
            () => {
              void import('../../../tests/helpers/mock-bridge').then(({ demoSkillInstallApprovalLong }) => {
                const installId = nextId('approval-skill-install')
                pendingSkillApprovals.set(installId, { sessionId, stage: 'install' })
                mock.emitAgentEvent({
                  type: 'approval_required',
                  sessionId,
                  request: { ...demoSkillInstallApprovalLong(), id: installId },
                })
              })
            },
            600,
          )
        } else {
          const messageId = nextId('msg-a')
          schedule(
            sessionId,
            () =>
              mock.emitAgentEvent({ type: 'message_start', sessionId, messageId, createdAt: Date.now() }),
            500,
          )
          chunkText('装好了,新建对话后就能用。', 8).forEach((delta, index) => {
            schedule(
              sessionId,
              () => mock.emitAgentEvent({ type: 'text_delta', sessionId, messageId, delta }),
              600 + index * 90,
            )
          })
          schedule(
            sessionId,
            () => mock.emitAgentEvent({ type: 'message_end', sessionId, messageId }),
            600 + chunkText('装好了,新建对话后就能用。', 8).length * 90,
          )
          schedule(
            sessionId,
            () => mock.emitAgentEvent({ type: 'agent_end', sessionId }),
            700 + chunkText('装好了,新建对话后就能用。', 8).length * 90,
          )
        }
      }
      return undefined
    }
    // 派活确认(0.3.0):先回 approval_resolved,再演示 run 状态流转(queued→running / rejected)
    const delegationRun = pendingDelegations.get(approvalId)
    if (delegationRun) {
      pendingDelegations.delete(approvalId)
      const managerSessionId = delegationRun.managerSessionId
      /** 发事件的同时记账:详情页此时若开着,getDetail 覆写要拿到同一个最新 run。 */
      const emitRun = (run: AgentRunSummary) => {
        demoRunState.set(run.runId, run)
        mock.emitAgentEvent({ type: 'agent_run_updated', managerSessionId, run })
      }
      schedule(
        managerSessionId,
        () =>
          mock.emitAgentEvent({
            type: 'approval_resolved',
            sessionId: managerSessionId,
            approvalId,
            decision: decision === 'reject' ? 'reject' : 'approve',
          }),
        200,
      )
      if (decision === 'reject') {
        schedule(
          managerSessionId,
          () =>
            emitRun({
              ...delegationRun,
              status: 'rejected',
              completedAt: Date.now(),
              updatedAt: Date.now(),
            }),
          400,
        )
      } else {
        const approved: AgentRunSummary = { ...delegationRun, internalSessionId: 'demo-run-internal-2' }
        schedule(
          managerSessionId,
          () => emitRun({ ...approved, status: 'queued', updatedAt: Date.now() }),
          400,
        )
        schedule(
          managerSessionId,
          () =>
            emitRun({ ...approved, status: 'running', startedAt: Date.now(), updatedAt: Date.now() }),
          1200,
        )
      }
      return undefined
    }
    const pending = pendingApprovals.get(approvalId)
    if (!pending) return Promise.reject(new Error('确认 ID 不存在或已经处理过了'))
    pendingApprovals.delete(approvalId)
    const { sessionId, toolCallId, messageId } = pending
    schedule(
      sessionId,
      () =>
        mock.emitAgentEvent({
          type: 'approval_resolved',
          sessionId,
          approvalId,
          decision: decision === 'reject' ? 'reject' : 'approve',
        }),
      200,
    )
    if (decision === 'approve') {
      schedule(
        sessionId,
        () =>
          mock.emitAgentEvent({
            type: 'tool_start',
            sessionId,
            messageId,
            execution: {
              toolCallId,
              toolName: 'move_files',
              displayName: '移动文件',
              status: 'running',
              summary: '移动 38 张图片到按月份建的文件夹',
            },
          }),
        500,
      )
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'tool_end', sessionId, toolCallId, status: 'succeeded' }),
        1400,
      )
    } else {
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'tool_end', sessionId, toolCallId, status: 'rejected' }),
        500,
      )
    }
    return undefined
  })

  mock.handle('message:send', ({ sessionId, text }) => {
    const detail = details.get(sessionId)
    if (!detail) return Promise.reject(new Error('这条会话不存在或已经删掉了'))
    const userMessage: ChatMessage = {
      kind: 'chat',
      role: 'user',
      id: nextId('msg-u'),
      text,
      createdAt: Date.now(),
    }
    details.set(sessionId, { ...detail, messages: [...detail.messages, userMessage] })

    const messageId = nextId('msg-a')
    const wantsApproval = /整理|移动|归档/.test(text)
    // 0.7.0 A 演示:「装个技能/技能市场」触发候选卡(8 候选满编 fixture)
    const wantsSkillMarket = /装个?技能|技能市场/.test(text)
    const reply = wantsSkillMarket
      ? '我在技能市场搜了一下,这些看起来靠谱,你挑一个:'
      : wantsApproval
        ? '数清楚了,一共 38 张图片。动手之前先问你一句:'
        : DEMO_REPLY

    schedule(
      sessionId,
      () =>
        mock.emitAgentEvent({ type: 'message_start', sessionId, messageId, createdAt: Date.now() }),
      250,
    )
    chunkText(reply, 14).forEach((delta, index) => {
      schedule(
        sessionId,
        () => mock.emitAgentEvent({ type: 'text_delta', sessionId, messageId, delta }),
        400 + index * 90,
      )
    })
    const afterText = 400 + chunkText(reply, 14).length * 90 + 150
    if (wantsSkillMarket) {
      schedule(
        sessionId,
        () => {
          void import('../../../tests/helpers/mock-bridge').then(
            ({ demoSkillCandidateApproval, DEMO_SKILL_MARKET_CANDIDATES_8 }) => {
              const candidateApprovalId = nextId('approval-skill-candidate')
              pendingSkillApprovals.set(candidateApprovalId, { sessionId, stage: 'candidate' })
              mock.emitAgentEvent({
                type: 'approval_required',
                sessionId,
                request: {
                  ...demoSkillCandidateApproval(Date.now(), DEMO_SKILL_MARKET_CANDIDATES_8),
                  id: candidateApprovalId,
                },
              })
            },
          )
        },
        afterText,
      )
    }
    if (wantsApproval) {
      const toolCallId = nextId('toolcall')
      const approvalId = nextId('approval')
      pendingApprovals.set(approvalId, { sessionId, toolCallId, messageId })
      schedule(
        sessionId,
        () =>
          mock.emitAgentEvent({
            type: 'approval_required',
            sessionId,
            request: {
              id: approvalId,
              kind: 'move',
              title: '要把这 38 张图片移到按月份建好的文件夹吗?',
              description:
                '我会在下载文件夹里建 6 个月份文件夹,把 38 张图片按拍摄月份移过去,原位置不保留副本。',
              itemCount: 38,
              samplePaths: [
                'C:\\Users\\demo\\Downloads\\IMG_2031.jpg',
                'C:\\Users\\demo\\Downloads\\IMG_2032.jpg',
                'C:\\Users\\demo\\Downloads\\截图 2026-07-01.png',
              ],
              recoverable: true,
              outsideWorkspace: false,
              toolCallId,
              createdAt: Date.now(),
            },
          }),
        afterText,
      )
    }
    schedule(
      sessionId,
      () => mock.emitAgentEvent({ type: 'message_end', sessionId, messageId }),
      afterText + 100,
    )
    schedule(
      sessionId,
      () => mock.emitAgentEvent({ type: 'agent_end', sessionId }),
      afterText + 200,
    )
    return userMessage
  })
}

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createBridge()
  .then((bridge) => {
    createRoot(container).render(
      <StrictMode>
        <App bridge={bridge} />
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    container.textContent = error instanceof Error ? error.message : String(error)
  })
