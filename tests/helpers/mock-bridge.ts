import type { DaweigeBridge } from '../../src/shared/ipc/bridge'
import type {
  ContractChannel,
  RequestOf,
  ResponseOf,
  BootstrapState,
} from '../../src/shared/ipc/contracts'
import type { AgentPushEvent } from '../../src/shared/ipc/events'
import type {
  AgentRunDetail,
  AgentRunSummary,
  InstalledSkill,
  RoleDetail,
  RoleSummary,
  SkillCandidateApprovalRequest,
  SkillInstallApprovalRequest,
  SkillMarketCandidate,
  UsageDashboard,
} from '../../src/shared/domain'
import { pruneRoleModelDefaults } from '../../src/shared/domain/model-selection'
import { validateResponse } from '../../src/shared/ipc/schemas'

export const DEMO_SKILL_MARKET_CANDIDATE: SkillMarketCandidate = {
  optionId: 'opt_demo_01',
  registryId: 'curated',
  slug: 'files-and-photos-organize',
  displayName: '文件与照片整理',
  summary: '按类型和日期整理散乱文件，执行前先给出方案。',
  owner: 'daweige',
  installs: 1_280,
  version: '1.0.0',
  license: 'MIT',
}

/**
 * 8 条候选的满编 fixture(0.7.0 A1 视觉/交互边界自测):
 * 长英文 slug、长中文简介、缺可选字段(owner/version/license 缺席)、GitHub 源带星标。
 * 字段全部来自契约,未发明任何字段。
 */
export const DEMO_SKILL_MARKET_CANDIDATES_8: readonly SkillMarketCandidate[] = [
  DEMO_SKILL_MARKET_CANDIDATE,
  {
    optionId: 'opt_demo_02',
    registryId: 'curated',
    slug: 'weekly-menu-planner',
    displayName: '一周菜谱',
    summary: '按家里口味和冰箱存货排一周菜谱,顺带列出要补买的菜。',
    owner: 'daweige',
    installs: 864,
    version: '0.9.2',
    license: 'Apache-2.0',
  },
  {
    optionId: 'opt_demo_03',
    registryId: 'github',
    slug: 'meeting-notes-to-action-items',
    displayName: 'meeting-notes-to-action-items',
    summary: 'Turn messy meeting notes into a checklist of action items with owners and due dates.',
    owner: 'agent-skills-community',
    stars: 2_457,
    version: '2.1.0',
    license: 'MIT',
  },
  {
    optionId: 'opt_demo_04',
    registryId: 'curated',
    slug: 'invoice-summary-cn',
    displayName: '发票汇总',
    summary:
      '把一摞发票照片或表格里的金额、税率、抬头逐项核对后汇总成一张总表,异常行单独列出;适合月底报销和门店对账场景,数字都有出处,不给没有依据的估算。',
    owner: 'daweige',
    installs: 12_304,
    version: '1.3.0',
    license: 'BSD-3-Clause',
  },
  {
    optionId: 'opt_demo_05',
    registryId: 'github',
    slug: 'super-long-english-slug-for-visual-overflow-testing-purposes-only',
    displayName: 'super-long-english-slug-for-visual-overflow-testing-purposes-only',
    summary: 'A deliberately long slug to prove narrow windows wrap instead of breaking layout.',
    stars: 8,
    license: 'CC0-1.0',
  },
  {
    optionId: 'opt_demo_06',
    registryId: 'curated',
    slug: 'travel-packing-list',
    displayName: '出行行李清单',
    summary: '按目的地天气和行程天数给一份行李清单,出门前逐项打勾。',
    owner: 'daweige',
    installs: 96,
  },
  {
    optionId: 'opt_demo_07',
    registryId: 'github',
    slug: 'readme-polisher',
    displayName: 'readme-polisher',
    summary: 'Polish README structure and wording.',
    owner: 'docs-lab',
    stars: 305,
    version: '0.4.1',
    license: 'Apache-2.0',
  },
  {
    optionId: 'opt_demo_08',
    registryId: 'curated',
    slug: 'essay-outline-builder',
    displayName: '长文提纲',
    summary: '先搭骨架再填肉的长文写法:三章九节,每节一句核心。',
    owner: 'daweige',
    installs: 5_678,
    version: '1.1.0',
    license: 'MIT',
  },
]

export function demoSkillCandidateApproval(
  createdAt = Date.now(),
  candidates: readonly SkillMarketCandidate[] = [DEMO_SKILL_MARKET_CANDIDATE],
): SkillCandidateApprovalRequest {
  return {
    id: 'approval-skill-candidate-demo',
    kind: 'skill-candidate',
    title: `找到 ${candidates.length} 个可用技能`,
    description: '请选择要继续预览的技能。',
    query: 'file organize',
    candidates,
    createdAt,
    toolCallId: 'tool-search-skills-demo',
  }
}

export function demoSkillInstallApproval(createdAt = Date.now()): SkillInstallApprovalRequest {
  return {
    id: 'approval-skill-install-demo',
    kind: 'skill-install',
    title: '准备安装“文件与照片整理”',
    description: '请确认来源、许可和技能正文预览。',
    candidate: DEMO_SKILL_MARKET_CANDIDATE,
    markdownPreview: '# 文件与照片整理\n\n先查看目录，再给出分类方案。',
    markdownBytes: 67,
    previewTruncated: false,
    targetLogicalLocation: 'daweige-skill://global/files-and-photos-organize/SKILL.md',
    createdAt,
    toolCallId: 'tool-install-skill-demo',
  }
}

/**
 * 超长截断预览 fixture(0.7.0 A2 视觉边界自测):正文超过 UI 预览预算,
 * previewTruncated=true,前端应头尾展示+中间明确截断标记。
 * 正文由确定模板拼装,不含任何真实密钥/路径。
 */
export function demoSkillInstallApprovalLong(createdAt = Date.now()): SkillInstallApprovalRequest {
  const section = (index: number) =>
    `\n\n## 第 ${index} 步\n\n- 先确认当前目录里有什么,不猜不编。\n- 把同类文件归到一处,命名保持 yyyy-mm 习惯。\n- 动手前列出清单给用户过目,用户点头再移。\n- 遇到拿不准的先问,不擅自做主。`
  let body = '# 文件与照片整理\n\n先查看目录,再给出分类方案;用户确认后才动手。'
  for (let i = 1; i <= 24; i += 1) body += section(i)
  body += '\n\n## 验收\n\n- 每张图片都有归属文件夹。\n- 原位置不留副本。\n- 清单和实际移动结果一致。\n'
  return {
    id: 'approval-skill-install-demo-long',
    kind: 'skill-install',
    title: '准备安装“文件与照片整理”',
    description: '请确认来源、许可和技能正文预览。',
    candidate: DEMO_SKILL_MARKET_CANDIDATE,
    markdownPreview: body,
    markdownBytes: new TextEncoder().encode(body).byteLength,
    previewTruncated: true,
    targetLogicalLocation: 'daweige-skill://global/files-and-photos-organize/SKILL.md',
    createdAt,
    toolCallId: 'tool-install-skill-demo-long',
  }
}

/**
 * 契约 mock 桥(M1-04)——渲染进程 UI 开发与单元测试用。
 *
 * 用法:
 *   const bridge = new MockBridge()
 *   bridge.seedDemoState()               // 预置演示数据,UI 开箱即用
 *   bridge.handle('session:list', async () => [...])   // 按通道覆写行为
 *   bridge.emitAgentEvent({ type: 'text_delta', ... }) // 驱动流式渲染测试
 *   bridge.calls                          // 断言渲染进程发了什么
 */

type Handler = (payload: unknown) => Promise<unknown>

export class MockBridge implements DaweigeBridge {
  readonly calls: Array<{ channel: string; payload: unknown }> = []
  private readonly handlers = new Map<string, Handler>()
  private readonly agentListeners = new Set<(event: AgentPushEvent) => void>()

  /**
   * 可选演练开关(默认关):置 true 后,下一次 role:delete 抛
   * EROLE_DELETE_CONFLICT(模拟 impactVersion 失效/输名不一致),
   * 前端应走「重拉影响清单回第 1 步」分支。抛一次后自动复位。
   */
  staleDeleteOnce = false

  /** 注册/覆写某通道的行为;未注册的通道 invoke 会 reject。 */
  handle<C extends ContractChannel>(
    channel: C,
    fn: (payload: RequestOf<C>) => Promise<ResponseOf<C>> | ResponseOf<C>,
  ): this {
    this.handlers.set(channel, fn as Handler)
    return this
  }

  async invoke<C extends ContractChannel>(
    channel: C,
    payload: RequestOf<C>,
  ): Promise<ResponseOf<C>> {
    this.calls.push({ channel, payload })
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(
        new Error(`MockBridge: 通道 ${channel} 未注册行为;请先 bridge.handle('${channel}', ...)`),
      )
    }
    const response = await handler(payload)
    const validation = validateResponse(channel, response)
    if (!validation.ok) throw new Error(`MockBridge: ${validation.message}`)
    return validation.value
  }

  onAgentEvent(listener: (event: AgentPushEvent) => void): () => void {
    this.agentListeners.add(listener)
    return () => this.agentListeners.delete(listener)
  }

  /** 手动推送 agent 事件(模拟流式输出、确认卡片等)。 */
  emitAgentEvent(event: AgentPushEvent): void {
    for (const listener of this.agentListeners) listener(event)
  }

  /** 清空调用记录(测试间复位)。 */
  resetCalls(): void {
    this.calls.length = 0
  }
  /** 预置一套演示数据:bootstrap/角色/会话/设置/凭据/提醒,未覆写的通道都有合理返回。 */
  seedDemoState(overrides?: Partial<BootstrapState>): this {
    const now = Date.now()
    /** 0.2.0 角色演示数据:覆盖 worker 活跃/归档角色、mount missing、会话归档等状态。 */
    const roles: RoleSummary[] = [
      {
        id: 'sys-xiaozhen',
        kind: 'manager',
        displayName: '小柊',
        templateId: 'manager-built-in',
        mounts: [],
        archivedAt: null,
        lifecycle: 'ready' as const,
        createdAt: now - 90 * 86_400_000,
        updatedAt: now - 600_000,
        sessionCount: 1,
        activeSessionCount: 1,
      },
      {
        id: 'agent-a1b2c3d4e5f6',
        kind: 'worker',
        displayName: '小编',
        templateId: 'writer',
        mounts: [
          { workspacePath: 'C:\\Users\\demo\\Documents\\稿件', primary: true, availability: 'available' },
        ],
        archivedAt: null,
        lifecycle: 'ready' as const,
        createdAt: now - 86_400_000,
        updatedAt: now - 1_800_000,
        sessionCount: 2,
        activeSessionCount: 1,
      },
      {
        id: 'agent-b2c3d4e5f6a7',
        kind: 'worker',
        displayName: '账房',
        templateId: 'accountant',
        mounts: [
          { workspacePath: 'D:\\门店报表', primary: true, availability: 'missing' },
        ],
        archivedAt: null,
        lifecycle: 'ready' as const,
        createdAt: now - 2 * 86_400_000,
        updatedAt: now - 3_600_000,
        sessionCount: 1,
        activeSessionCount: 1,
      },
      {
        id: 'agent-c3d4e5f6a7b8',
        kind: 'worker',
        displayName: '旧管家',
        templateId: 'file-steward',
        mounts: [
          { workspacePath: 'E:\\归档文件', primary: true, availability: 'available' },
        ],
        archivedAt: now - 10 * 86_400_000,
        lifecycle: 'ready' as const,
        createdAt: now - 30 * 86_400_000,
        updatedAt: now - 10 * 86_400_000,
        sessionCount: 1,
        activeSessionCount: 1,
      },
      {
        id: 'agent-e5f6a7b8c9d0',
        kind: 'legacy-unresolved',
        displayName: '未找到文件夹的旧会话 (a1b2)',
        templateId: 'legacy-empty',
        mounts: [],
        archivedAt: null,
        lifecycle: 'ready' as const,
        createdAt: now - 40 * 86_400_000,
        updatedAt: now - 20 * 86_400_000,
        sessionCount: 1,
        activeSessionCount: 1,
      },
    ]
    const roleDetail: Record<string, RoleDetail> = {
      'agent-a1b2c3d4e5f6': {
        summary: roles.find((r) => r.id === 'agent-a1b2c3d4e5f6')!,
        profile: {
          schemaVersion: 1,
          roleId: 'agent-a1b2c3d4e5f6',
          templateId: 'writer',
          personaSummary: '擅长把零散材料整理成清楚、自然的中文稿件。',
          capabilityTags: ['写作', '改稿', '整理素材'],
        },
        guardrails: '# 角色守则\n\n## 身份\n你是小编,一位耐心的中文写稿助手。\n\n## 工作方式\n- 动笔前先确认题材、读者和篇幅。\n- 初稿完成后主动列出可以再打磨的点。\n\n## 不要做\n- 不堆砌形容词,不用翻译腔。',
        guardrailsVersion: 1,
      },
    }
    const bootstrap: BootstrapState = {
      appVersion: '0.1.0-mock',
      manager: { roleId: 'sys-xiaozhen', entrySessionId: 'demo-session-manager' },
      roles,
      sessions: [
        {
          id: 'demo-session-manager',
          title: '和小柊聊天',
          workspacePath: '',
          roleId: 'sys-xiaozhen',
          archivedAt: null,
          providerId: 'kimi-coding',
          modelId: 'kimi-for-coding',
          createdAt: now - 7_200_000,
          updatedAt: now - 600_000,
          messageCount: 4,
        },
        {
          id: 'demo-session-1',
          title: '整理下载文件夹',
          workspacePath: 'C:\\Users\\demo\\Documents\\稿件',
          roleId: 'agent-a1b2c3d4e5f6',
          archivedAt: null,
          providerId: 'kimi-coding',
          modelId: 'kimi-for-coding',
          createdAt: now - 3_600_000,
          updatedAt: now - 1_800_000,
          messageCount: 6,
        },
        {
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
        },
        {
          id: 'demo-session-legacy',
          title: '找不到文件夹前的旧对话',
          workspacePath: '',
          roleId: 'agent-e5f6a7b8c9d0',
          archivedAt: null,
          providerId: 'kimi-coding',
          modelId: 'kimi-for-coding',
          createdAt: now - 40 * 86_400_000,
          updatedAt: now - 20 * 86_400_000,
          messageCount: 3,
        },
      ],
      settings: {
        providerSelection: { providerId: 'kimi-coding', modelId: 'kimi-for-coding' },
        windowBounds: { width: 1280, height: 840, maximized: false },
        lastActiveSessionId: 'demo-session-1',
      },
      providers: [
        {
          id: 'kimi-coding',
          displayName: 'Kimi',
          defaultModelId: 'kimi-for-coding',
          description: 'Kimi Coding Plan',
          supportsThinking: true,
          contextWindow: 262144,
        },
        {
          id: 'zai',
          displayName: 'GLM(国际)',
          defaultModelId: 'glm-4.7',
          description: 'ZAI Coding Plan 国际区',
          supportsThinking: true,
          contextWindow: 1000000,
        },
        {
          id: 'zai-coding-cn',
          displayName: 'GLM(国内)',
          defaultModelId: 'glm-4.7',
          description: 'ZAI Coding Plan 国内区',
          supportsThinking: true,
          contextWindow: 1000000,
        },
        {
          id: 'deepseek',
          displayName: 'DeepSeek',
          defaultModelId: 'deepseek-v4-flash',
          description: 'DeepSeek 官方 API(flash 档)',
          supportsThinking: true,
          contextWindow: 1000000,
        },
      ],
      credentialStatuses: [
        { providerId: 'kimi-coding', configured: true, maskedKey: 'sk-****demo' },
        { providerId: 'zai', configured: false },
        { providerId: 'zai-coding-cn', configured: false },
        { providerId: 'deepseek', configured: false },
      ],
      upcomingReminders: [
        {
          memoryId: 'demo-memory-1',
          title: '妈妈生日',
          date: '2026-08-25',
          daysUntil: 3,
        },
      ],
      ...overrides,
    }

    this.handle('app:getBootstrapState', () => bootstrap)
    this.handle('session:list', () => bootstrap.sessions)
    this.handle('role:listTemplates', () => [
      {
        id: 'writer',
        name: '写稿助手',
        description: '把零散材料整理成清楚自然的中文稿件',
        guardrailsDraft: '# 角色守则\n\n## 身份\n你是一位耐心的中文写稿助手。\n\n## 工作方式\n- 动笔前先确认题材、读者和篇幅。\n- 初稿完成后主动列出可以再打磨的点。\n\n## 不要做\n- 不堆砌形容词,不用翻译腔。',
      },
      {
        id: 'accountant',
        name: '表格会计',
        description: '读表格、算数字、出汇总,结果明确不含糊',
        guardrailsDraft: '# 角色守则\n\n## 身份\n你是一位细致的表格会计。\n\n## 工作方式\n- 先读预览再计算,数值算好再写入,不依赖公式重算。\n- 结果同时给总额和明细。\n\n## 不要做\n- 不给没有依据的估算数。',
      },
      {
        id: 'file-steward',
        name: '文件管家',
        description: '分类整理文件夹,批量改名挪位一把好手',
        guardrailsDraft: '# 角色守则\n\n## 身份\n你是一位靠谱的文件管家。\n\n## 工作方式\n- 先摸清文件夹结构再动手,批量操作前说清影响多少文件。\n- 分类方案拿不准时先问用户。\n\n## 不要做\n- 不动用户没有确认过的大批文件。',
      },
      {
        id: 'notebook',
        name: '记事本',
        description: '生活琐事随口记,回头一问就能想起来',
        guardrailsDraft: '# 角色守则\n\n## 身份\n你是家里的记事本,负责记生活琐事。\n\n## 工作方式\n- 用户说"记住 XX"就调 save_memory 保存并口头确认。\n- 回答前先检索记事原文,不凭印象编。\n\n## 不要做\n- 不主动把私事写进任何文件。',
      },
    ] satisfies ResponseOf<'role:listTemplates'>)
    this.handle('role:list', () => roles)
    this.handle('role:get', ({ roleId }) => {
      const detail = roleDetail[roleId]
      if (!detail) throw new Error(`MockBridge: 未预置角色 ${roleId} 的详情`)
      return detail
    })
    this.handle('role:create', ({ displayName, workspacePaths, templateId, guardrails }) => {
      const created: RoleDetail = {
        summary: {
          id: 'agent-d4e5f6a7b8c9',
          kind: 'worker',
          displayName,
          templateId,
          mounts: workspacePaths.map((p, i) => ({
            workspacePath: p,
            primary: i === 0,
            availability: 'available' as const,
          })),
          archivedAt: null,
          lifecycle: 'ready' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sessionCount: 0,
          activeSessionCount: 0,
        },
        profile: {
          schemaVersion: 1,
          roleId: 'agent-d4e5f6a7b8c9',
          templateId,
          personaSummary: '',
          capabilityTags: [],
        },
        guardrails,
        guardrailsVersion: 1,
      }
      roles.push(created.summary)
      roleDetail[created.summary.id] = created
      return created
    })
    this.handle('role:update', ({ roleId, displayName }) => {
      const role = roles.find((r) => r.id === roleId)
      if (!role) throw new Error(`MockBridge: 未预置角色 ${roleId}`)
      return { ...role, displayName, updatedAt: Date.now() }
    })
    this.handle('role:updateGuardrails', ({ roleId, guardrails }) => {
      const detail = roleDetail[roleId]
      if (!detail) throw new Error(`MockBridge: 未预置角色 ${roleId} 的详情`)
      return { ...detail, guardrails, guardrailsVersion: detail.guardrailsVersion + 1 }
    })
    this.handle('role:archive', ({ roleId }) => {
      const role = roles.find((r) => r.id === roleId)
      if (!role) throw new Error(`MockBridge: 未预置角色 ${roleId}`)
      return { ...role, archivedAt: Date.now() }
    })
    this.handle('role:restore', ({ roleId }) => {
      const role = roles.find((r) => r.id === roleId)
      if (!role) throw new Error(`MockBridge: 未预置角色 ${roleId}`)
      return { ...role, archivedAt: null }
    })
    this.handle('role:getDeleteImpact', ({ roleId }) => {
      const role = roles.find((r) => r.id === roleId)
      if (!role) throw new Error(`MockBridge: 未预置角色 ${roleId}`)
      return {
        roleId,
        displayName: role.displayName,
        sessionCount: role.sessionCount,
        sessionTitles: ['整理下载文件夹'],
        homePath: 'daweige/agents/' + roleId,
        impactVersion: 'mock-impact-v1',
      }
    })
    this.handle('role:delete', ({ roleId }) => {
      if (this.staleDeleteOnce) {
        this.staleDeleteOnce = false
        // 形态对齐 preload 解码结果:Error.name 即 IPC 错误码
        const err = new Error('角色的信息刚发生过变化,影响清单已刷新;请重新确认后再删')
        err.name = 'EROLE_DELETE_CONFLICT'
        return Promise.reject(err)
      }
      return { deletedRoleId: roleId, deletedSessionIds: [] }
    })
    this.handle('session:archive', ({ sessionId }) => {
      const session = bootstrap.sessions.find((s) => s.id === sessionId)
      if (!session) throw new Error(`MockBridge: 未预置会话 ${sessionId}`)
      return { ...session, archivedAt: Date.now() }
    })
    this.handle('session:restore', ({ sessionId }) => {
      const session = bootstrap.sessions.find((s) => s.id === sessionId)
      if (!session) throw new Error(`MockBridge: 未预置会话 ${sessionId}`)
      return { ...session, archivedAt: null }
    })
    this.handle('settings:get', () => bootstrap.settings)
    // ⑤审整改:复刻主进程 settings-handlers 的角色默认剪枝(池外/非法 key),mock 与真实行为对齐
    this.handle('settings:update', ({ settings }) => pruneRoleModelDefaults(settings))
    // A-14 演示:恢复默认=migrate(默认路径)→ isDefault 回 true(后端契约如此)
    const demoManagerDefaultWorkspace =
      'C:/Users/demo/AppData/Roaming/大微阁/daweige/system/sys-xiaozhen/workspace'
    this.handle('managerWorkspace:get', () => ({
      effectivePath: demoManagerDefaultWorkspace,
      isDefault: true,
      restartRequired: false,
    }))
    this.handle('managerWorkspace:migrate', ({ targetPath }) => ({
      effectivePath: targetPath,
      isDefault: targetPath === demoManagerDefaultWorkspace,
      restartRequired: true,
    }))
    this.handle('credential:status', () => bootstrap.credentialStatuses)
    this.handle('credential:delete', ({ providerId }) => ({
      providerId,
      configured: false,
    }))
    // A-10 演示:Kimi 固定单项(后端行为);GLM 两项(默认+在线);DeepSeek 演示在线失败回退默认列表+notice
    this.handle('credential:listModels', ({ providerId }) => {
      if (providerId === 'kimi-coding') {
        return {
          models: [{ id: 'kimi-for-coding', contextWindow: 262144, source: 'catalog' as const }],
        }
      }
      if (providerId === 'deepseek') {
        return {
          models: [
            { id: 'deepseek-v4-flash', contextWindow: 1000000, source: 'catalog' as const },
          ],
          notice: '在线拉取失败,先显示默认列表',
        }
      }
      return {
        models: [
          { id: 'glm-4.7', contextWindow: 204800, source: 'catalog' as const },
          { id: 'glm-4.7-air', contextWindow: 131072, source: 'online' as const },
          { id: 'glm-4.7-flashx', source: 'online' as const },
        ],
      }
    })
    this.handle('reminder:listUpcoming', () => bootstrap.upcomingReminders)
    let skillGeneration = 1
    let mockSkills: InstalledSkill[] = [
      {
        id: 'global:demo-skill',
        name: 'demo-skill',
        description: '演示技能',
        source: { kind: 'global' },
        builtIn: false,
        logicalLocation: 'daweige-skill://global/demo-skill/SKILL.md',
        provenance: {
          kind: 'market',
          registryId: 'curated',
          registryName: '内置精选',
          slug: 'demo-skill',
          installedAt: now - 86_400_000,
          license: 'MIT',
        },
        canUninstall: true,
      },
    ]
    const skillSnapshot = () => ({
      generation: skillGeneration,
      skills: mockSkills,
      diagnostics: [],
      effectiveFrom: 'new-session' as const,
    })
    this.handle('skill:list', () => skillSnapshot())
    this.handle('skill:refresh', () => {
      skillGeneration += 1
      return skillSnapshot()
    })
    this.handle('skill:uninstall', ({ skillId, expectedGeneration }) => {
      if (expectedGeneration !== skillGeneration) throw new Error('技能列表已经变化,请刷新后重试')
      const skill = mockSkills.find((item) => item.id === skillId)
      if (!skill?.canUninstall) throw new Error('这个技能不能由设置页卸载')
      mockSkills = mockSkills.filter((item) => item.id !== skillId)
      skillGeneration += 1
      return skillSnapshot()
    })
    this.handle('skill:openFolder', () => undefined)
    let memoryRevision = 1
    let memoryEntries = [
      {
        id: '2026-08-30T12-00-00-demo-memory.md',
        content: '演示记忆',
        createdAt: now,
        source: {
          kind: 'conversation' as const,
          roleId: 'sys-xiaozhen',
          roleDisplayName: '小柊',
        },
      },
    ]
    this.handle('memory:list', ({ cursor, limit = 50 }) => {
      const match = cursor === undefined ? undefined : /^mock:(\d+):(\d+)$/.exec(cursor)
      const cursorRevision = match ? Number(match[1]) : memoryRevision
      const reset = cursor !== undefined && cursorRevision !== memoryRevision
      const offset = reset || !match ? 0 : Number(match[2])
      const entries = memoryEntries.slice(offset, offset + limit)
      const nextOffset = offset + entries.length
      return {
        revision: memoryRevision,
        mergeState: 'clean',
        entries,
        ...(nextOffset < memoryEntries.length ? { nextCursor: `mock:${memoryRevision}:${nextOffset}` } : {}),
        total: memoryEntries.length,
        reset,
      }
    })
    this.handle('memory:delete', ({ memoryId }) => {
      const before = memoryEntries.length
      memoryEntries = memoryEntries.filter((entry) => entry.id !== memoryId)
      const deleted = memoryEntries.length !== before
      if (deleted) memoryRevision += 1
      return { deleted, revision: memoryRevision, mergeState: deleted ? 'pending' : 'clean' }
    })
    this.handle('memory:clear', () => {
      const deletedCount = memoryEntries.length
      memoryEntries = []
      if (deletedCount > 0) memoryRevision += 1
      return { deletedCount, revision: memoryRevision, mergeState: deletedCount > 0 ? 'pending' : 'clean' }
    })
    this.handle('workspace:choose', () => 'C:\\Users\\demo\\Documents\\测试工作区')
    this.handle('session:rename', ({ sessionId, title }) => ({
      ...(bootstrap.sessions.find((s) => s.id === sessionId) ?? bootstrap.sessions[0]!),
      title,
      updatedAt: Date.now(),
    }))
    this.handle('session:delete', () => undefined)
    this.handle('message:abort', () => undefined)
    this.handle('approval:respond', () => undefined)
    // 0.3.0 派活演示:awaiting(待确认)/ completed(含用量)/ interrupted(中断可追溯)三态
    // 0.4.0 D:a→b 组成一条交棒链(graph-0123…),c 是独立链——族谱 UI 演示数据
    const demoRuns: AgentRunSummary[] = [
      {
        runId: 'run-a1b2c3d4e5f60718',
        managerSessionId: 'demo-session-manager',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleName: '账房',
        internalSessionId: 'demo-run-internal-1',
        parentRunId: null,
        status: 'completed',
        waitingReason: null,
        graphId: 'graph-0123456789abcdef',
        dependsOnRunIds: [],
        queueReason: null,
        followupCount: 1,
        interruptSource: null,
        taskBrief: '汇总 D:\\门店报表 下所有门店的月度销售表,输出总额与异常行',
        allowedWorkspacePaths: ['D:\\门店报表'],
        usage: {
          rounds: 6,
          inputTokens: 48_200,
          outputTokens: 12_930,
          cacheReadTokens: 130_022,
          cacheWriteTokens: 9_400,
          totalTokens: 200_552,
        },
        createdAt: now - 3_600_000,
        startedAt: now - 3_590_000,
        completedAt: now - 1_800_000,
        updatedAt: now - 1_800_000,
      },
      {
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
        usage: { rounds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
        createdAt: now - 120_000,
        startedAt: null,
        completedAt: null,
        updatedAt: now - 120_000,
      },
      {
        runId: 'run-c3d4e5f6a7b80931',
        managerSessionId: 'demo-session-manager',
        targetRoleId: 'agent-b2c3d4e5f6a7',
        targetRoleName: '账房',
        internalSessionId: 'demo-run-internal-3',
        parentRunId: null,
        status: 'interrupted',
        waitingReason: null,
        graphId: 'graph-fedcba9876543210',
        dependsOnRunIds: [],
        queueReason: null,
        followupCount: 0,
        interruptSource: 'app-restart',
        taskBrief: '核对上月发票与入库单',
        allowedWorkspacePaths: ['D:\\门店报表'],
        usage: { rounds: 2, inputTokens: 9_100, outputTokens: 2_040, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11_140 },
        createdAt: now - 2 * 86_400_000,
        startedAt: now - 2 * 86_400_000 + 10_000,
        completedAt: null,
        updatedAt: now - 2 * 86_400_000 + 300_000,
        failureMessage: '应用上次在派活中途退出,本次没有自动继续',
      },
    ]
    this.handle('agentRun:list', ({ managerSessionId }) =>
      demoRuns.filter((r) => r.managerSessionId === managerSessionId),
    )
    this.handle('agentRun:getGraph', ({ graphId, managerSessionId }) => {
      const nodes = demoRuns.filter((r) => r.graphId === graphId)
      if (nodes.length === 0) throw new Error(`MockBridge: 未预置协作链 ${graphId}`)
      // ownership 与真实服务同语义:graph 必须属于该 manager 会话
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
          active: nodes.filter((n) => n.status === 'running' || n.status === 'waiting' || n.status === 'awaiting-approval' || n.status === 'queued').length,
          completed: nodes.filter((n) => n.status === 'completed').length,
          failed: nodes.filter((n) => n.status === 'failed' || n.status === 'rejected').length,
          interrupted: nodes.filter((n) => n.status === 'interrupted').length,
          totalTokens: nodes.reduce((sum, n) => sum + n.usage.totalTokens, 0),
        },
      }
    })
    this.handle('agentRun:interrupt', ({ runId, managerSessionId }) => {
      const run = demoRuns.find((r) => r.runId === runId)
      if (!run) throw new Error(`MockBridge: 未预置派活 ${runId}`)
      if (run.managerSessionId !== managerSessionId) {
        throw new Error('MockBridge: 派活不属于该总管会话')
      }
      // 真实语义:非终态打断成 interrupted(user);终态幂等返回原状
      if (run.status !== 'completed' && run.status !== 'failed' &&
          run.status !== 'rejected' && run.status !== 'interrupted') {
        const index = demoRuns.indexOf(run)
        demoRuns[index] = {
          ...run,
          status: 'interrupted',
          interruptSource: 'user',
          failureMessage: '用户打断了这条派活;已完成的产出保留,未完成的没有继续',
          updatedAt: Date.now(),
        }
        return demoRuns[index]!
      }
      return run
    })
    this.handle('agentRun:getDetail', ({ runId }) => {
      const run = demoRuns.find((r) => r.runId === runId)
      if (!run) throw new Error(`MockBridge: 未预置派活 ${runId}`)
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
                  messageCount: 8,
                },
                messages: [],
              },
        readOnly: true,
      }
      return detail
    })
    return this
  }
}

/**
 * 使用统计演示 fixture(usage:getDashboard):确定性伪随机,供 UI 预览与测试种数据。
 * 用法:bridge.handle('usage:getDashboard', () => demoUsageDashboard())
 * 传 { hasData: false } 得零值骨架(日期结构保留)。
 */
export function demoUsageDashboard(options?: {
  readonly hasData?: boolean
  readonly today?: Date
}): UsageDashboard {
  const hasData = options?.hasData ?? true
  const today = options?.today ?? new Date()

  const dateOf = (offsetBack: number): string => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetBack)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
  }

  // 确定性 LCG,同一 today 生成同一份数据
  let seed = 20260824
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  const days = Array.from({ length: 365 }, (_, i) => {
    const offset = 364 - i
    const value = hasData && rand() > 0.45 ? Math.round(rand() * 60000) : 0
    return { date: dateOf(offset), totalTokens: value }
  })

  const trendDates = Array.from({ length: 30 }, (_, i) => dateOf(29 - i))
  const trendSeries = [
    {
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      values: trendDates.map(() => (hasData ? Math.round(rand() * 40000) : 0)),
    },
    {
      provider: 'zai-coding-cn',
      model: 'glm-4.7',
      values: trendDates.map(() => (hasData ? Math.round(rand() * 25000) : 0)),
    },
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      values: trendDates.map(() => (hasData ? Math.round(rand() * 12000) : 0)),
    },
  ]

  const totalTokens = hasData ? 8_432_168 : 0
  return {
    schemaVersion: 2,
    generatedAt: today.getTime(),
    timeZone: 'Asia/Shanghai',
    hasData,
    overview: {
      totalTokens,
      peakDailyTokens: hasData ? 58_432 : 0,
      longestActiveSessionDurationMs: hasData ? 9_360_000 : 0, // 2小时36分
      currentStreakDays: hasData ? 6 : 0,
      longestStreakDays: hasData ? 21 : 0,
    },
    activity: { fromDate: dateOf(364), toDate: dateOf(0), days },
    trend: { fromDate: trendDates[0]!, toDate: trendDates[29]!, dates: trendDates, series: trendSeries },
    models: {
      totalTokens,
      items: hasData
        ? [
            { provider: 'kimi-coding', model: 'kimi-for-coding', totalTokens: 5_104_220 },
            { provider: 'zai-coding-cn', model: 'glm-4.7', totalTokens: 2_301_948 },
            { provider: 'deepseek', model: 'deepseek-v4-flash', totalTokens: 1_026_000 },
          ]
        : [],
    },
    delegations: { totalTokens: hasData ? 211_692 : 0, runs: [] },
  }
}
