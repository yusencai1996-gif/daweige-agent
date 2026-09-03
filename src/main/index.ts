import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { createMainWindow } from './window'
import { installCspHeader } from './security/csp'
import { redactCommonSecrets } from './security/redaction'
import { CredentialStore } from './security/credential-store'
import { createElectronSafeStorage } from './security/safe-storage-adapter'
import { SettingsStore } from './storage/settings-store'
import { SessionRepository } from './storage/session-repository'
import { SessionService } from './storage/session-service'
import { RoleRepository } from './roles/role-repository'
import { RoleService } from './roles/role-service'
import { RoleMigration } from './roles/role-migration'
import { ManagerSeedService } from './roles/system-manager'
import { ManagerWorkspaceResolver } from './manager-workspace/resolver'
import {
  ManagerWorkspaceMigrationService,
} from './manager-workspace/migration-service'
import { registerManagerWorkspaceHandlers } from './ipc/manager-workspace-handlers'
import { CapabilityStore } from './sandbox/capability-store'
import { CommandApprovalCache } from './command/command-approval-cache'
import { createRunCommandTool } from './agent/tools/run-command'
import {
  CAP_SID_ENV_KEY,
  launchHelperTransport,
  type FrameTransport,
} from './sandbox/sandbox-process-host'
import {
  FakeSandboxExecutor,
  FramedSandboxExecutor,
  type SandboxExecutor,
} from './sandbox/executor'
import {
  SYSTEM_MANAGER_ROLE_ID,
  type ManagerBootstrap,
} from '../shared/domain/manager'
import { ProviderRegistry } from './agent/provider-registry'
import { ConnectivityService } from './agent/connectivity-service'
import { AgentService, type AgentModels } from './agent/agent-service'
import { ApprovalBroker } from './agent/approval-broker'
import { createApprovalGate } from './agent/approval-gate'
import { buildTools } from './agent/tool-registry'
import { createMemoryTools } from './agent/tools/memory-tools'
import { createEditRoleGuardrailsTool } from './agent/tools/edit-role-guardrails'
import type { RolePromptLayer } from './agent/prompt-composer'
import { PathPolicy, StrictDelegationPathPolicy } from './files/path-policy'
import { FileOps } from './files/file-ops'
import { MemoryStore } from './memory/memory-store'
import { GlobalMemoryStore } from './memory/global-memory-store'
import { MemoryConsolidationService } from './memory/memory-consolidation-service'
import { createMemoryPromptProvider } from './memory/memory-prompt'
import { ReminderService } from './memory/reminder-service'
import { UsageStore } from './usage/usage-store'
import { UsageService } from './usage/usage-service'
import type { AgentPushEvent } from '../shared/ipc/events'
import { PUSH_CHANNELS } from '../shared/ipc/channels'
import { installIpcGate, uninstallIpcGate } from './ipc/handler'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerCredentialHandlers } from './ipc/credential-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { registerSessionHandlers } from './ipc/session-handlers'
import { registerRoleHandlers } from './ipc/role-handlers'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { registerMessageHandlers } from './ipc/message-handlers'
import { resolveRoleModel } from '../shared/domain/model-selection'
import { registerApprovalHandlers } from './ipc/approval-handlers'
import { registerWindowHandlers } from './ipc/window-handlers'
import { registerMemoryHandlers } from './ipc/memory-handlers'
import { registerSkillHandlers } from './ipc/skill-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerAgentRunHandlers } from './ipc/agent-run-handlers'
import { WorkerRunner } from './manager/worker-runner'
import { WorkspaceLeaseService } from './manager/workspace-lease-service'
import { ManagerOrchestrator } from './manager/manager-orchestrator'
import { AgentRunQueryService } from './manager/agent-run-query-service'
import { AgentRunRecovery } from './manager/agent-run-recovery'
import { ManagerCleanupService } from './manager/manager-cleanup-service'
import { ScriptedAgentTurnRunner } from './manager/scripted-agent-turn-runner'
import type { AgentTurnRunner } from './agent/agent-service'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { currentIanaTimeZone, localDateFor } from './usage/usage-parser'
import { UpdateService } from './update/update-service'
import { WorkspaceAuthorization } from './ipc/workspace-auth'
import { SkillCatalogService } from './skills/skill-catalog-service'
import { seedDefaultGlobalSkills, seedExistingDefaultSkills } from './skills/default-skill-migration'
import { SkillRegistryHttpClient } from './skills/market/skill-registry-http-client'
import { CuratedCatalogRegistry } from './skills/market/curated-catalog'
import { GitHubRegistry } from './skills/market/github-registry'
import { SkillRegistryService } from './skills/market/registry-service'
import { SkillInstallationStore } from './skills/market/skill-installation-store'
import { SkillInstallTokenStore } from './skills/market/skill-install-token-store'
import { createSkillMarketTools } from './skills/market/skill-market-tools'
import { FauxSkillRegistry } from './skills/market/faux-registry'
import { DefaultManagedSkillWriteResolver } from './skills/managed-skill-write'

/**
 * 主进程入口。
 * 启动顺序:app.ready → CSP → 仓库初始化 → IPC Gate → 窗口。
 * 记事(M5)随里程碑接入 toolchain 的 memoryTools。
 */

const devServerUrl = process.env.ELECTRON_RENDERER_URL

// 单实例锁:双实例共库会互抢 pi writer lease/竞争 staging 与删除流程(后端专审建议)
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
  // 第二实例没有任何已开资源,同步立即退出——异步 quit 的竞争窗口里模块顶层
  // 初始化会照常执行,半退出态被拆会触发原生异常弹窗(0x80000003,0.2.2 实测)
  process.exit(0)
}
app.on('second-instance', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// E2E 测试注入:显式设置 DAWEIGE_USER_DATA 时用独立 userData(临时目录),
// 避免测试建删角色污染真实开发库;正常启动不设此变量,不受影响。
// 双门铁律:打包版无条件忽略(生产环境变量不能重定向用户数据目录)
if (!app.isPackaged && process.env.DAWEIGE_USER_DATA) {
  app.setPath('userData', process.env.DAWEIGE_USER_DATA)
}

let sessionRepository: SessionRepository | undefined
let roleRepositoryRef: RoleRepository | undefined
let approvalBrokerRef: ApprovalBroker | undefined
let usageServiceRef: UsageService | undefined
let memoryConsolidationRef: MemoryConsolidationService | undefined
let managerOrchestratorRef: ManagerOrchestrator | undefined
let agentServiceRef: AgentService | undefined
let quitting = false

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  // 开发/E2E 双门：打包版永远忽略环境变量；独立 userData 防测试污染真实数据。
  const e2eScenario = !app.isPackaged && process.env.DAWEIGE_USER_DATA
    ? process.env.DAWEIGE_E2E_SCENARIO
    : undefined
  const credentialStore = new CredentialStore({
    safeStorage: createElectronSafeStorage(),
    secretsDir: join(userData, 'secrets'),
  })
  const settingsStore = new SettingsStore(join(userData, 'settings.json'))
  // 0.4.0 A(A-14):总管工作区解析器——manager 会话 cwd 的唯一权威来源
  const managerWorkspaceResolver = new ManagerWorkspaceResolver(userData, settingsStore)
  sessionRepository = new SessionRepository(join(userData, 'data', 'sessions.sqlite'))
  // 角色层(0.2.0):角色库与 pi 会话库分离;库损坏不拦启动(角色功能降级)
  let roleService: RoleService | undefined
  let roleRepository: RoleRepository | undefined
  try {
    roleRepository = new RoleRepository(join(userData, 'data', 'roles.sqlite'))
    roleService = new RoleService(userData, roleRepository, sessionRepository)
    roleRepositoryRef = roleRepository
  } catch (err) {
    console.error('[roles] 角色库初始化失败,本次运行关闭角色功能:', err instanceof Error ? err.message : err)
  }
  const sessionService = new SessionService(
    sessionRepository,
    roleRepository,
    roleService,
    userData,
    managerWorkspaceResolver,
  )
  const skillCatalog = new SkillCatalogService(userData, async () => {
    if (!roleRepository) return []
    return (await roleRepository.listRoleRows()).map((row) => ({
      roleId: row.id,
      roleDisplayName: row.displayName,
      templateId: row.templateId,
    }))
  })
  const providerRegistry = new ProviderRegistry(credentialStore)
  const connectivityService = new ConnectivityService(providerRegistry, credentialStore)

  const emitAgentEvent = (event: AgentPushEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(PUSH_CHANNELS[0], event)
      } catch {
        // 窗口销毁瞬间 send 可能抛:推送丢失可接受,绝不传染工具执行结果(如已跑完的命令被翻成 failed)
      }
    }
  }
  // 使用统计:库损坏/不可建时整体降级(只关统计功能,绝不拦应用启动)——后端复审整改项
  let usageService: UsageService | undefined
  let usageStore: UsageStore | undefined
  const repo = sessionRepository
  try {
    usageStore = new UsageStore(join(userData, 'data', 'usage.sqlite'))
    usageService = new UsageService(usageStore, {
      emitEvent: emitAgentEvent,
      iterateUsageEntries: () => repo.iterateUsageEntries(),
      logError: (message, error) =>
        console.error(
          `[usage] ${message}:`,
          redactCommonSecrets(error instanceof Error ? error.message : String(error)),
        ),
    })
  } catch (err) {
    console.error(
      '[usage] 统计库初始化失败,本次运行关闭使用统计:',
      redactCommonSecrets(err instanceof Error ? err.message : String(err)),
    )
  }
  usageServiceRef = usageService
  const approvalBroker = new ApprovalBroker(emitAgentEvent)
  const skillRegistryHttp = new SkillRegistryHttpClient()
  const skillRegistry = new SkillRegistryService(e2eScenario?.startsWith('skill-market')
    ? [new FauxSkillRegistry()]
    : [new CuratedCatalogRegistry(skillRegistryHttp), new GitHubRegistry(skillRegistryHttp)])
  const skillInstallations = new SkillInstallationStore(skillCatalog.globalSkillsRoot())
  const managedSkillWrite = new DefaultManagedSkillWriteResolver(skillInstallations, skillCatalog)
  const skillInstallTokens = new SkillInstallTokenStore(
    e2eScenario?.startsWith('skill-market')
      ? () => 'inst_e2e_skill_market_once_0001'
      : undefined,
  )
  await skillInstallations.cleanupStale()
  const updateService = new UpdateService({ emitEvent: emitAgentEvent })
  approvalBrokerRef = approvalBroker
  const workspaceAuth = new WorkspaceAuthorization()
  // 双门 E2E 场景注入(0.4.0 C):非打包 + 独立 userData 才认(packaged 一律忽略,不进生产装配)
  // 0.4.0 C3:命令能力装配(capability 钥匙库+精确缓存+惰性沙箱执行器)
  const capabilityStore = new CapabilityStore(join(userData, 'sandbox', 'capabilities-v1.json'))
  const commandApprovalCache = new CommandApprovalCache()
  const sandboxTransportRef: { current?: Promise<FrameTransport> } = {}
  const sandboxExecutor: SandboxExecutor = e2eScenario === 'command-happy'
    // E2E:fake 沙箱(只替换 OS spawn;Policy/审批/工具编排全真),预脚本化本场景唯一命令
    ? new FakeSandboxExecutor().script('python summarize.py', {
        output: '合计 42 行,共 3 个文件',
        exitCode: 0,
      })
    : {
    async run(input, events, signal) {
      // 惰性起 helper;失败清引用下次重试(fail-closed:错误传工具层转人话)
      if (!sandboxTransportRef.current) {
        sandboxTransportRef.current = launchHelperTransport((msg) =>
          console.error(`[sandbox] ${redactCommonSecrets(msg)}`),
        ).catch((err) => {
          sandboxTransportRef.current = undefined
          throw err
        })
      }
      const transport = await sandboxTransportRef.current
      const executor = new FramedSandboxExecutor(transport, (capSid) => ({
        SystemRoot: 'C:\Windows',
        WINDIR: 'C:\Windows',
        ComSpec: 'C:\Windows\System32\cmd.exe',
        PATH: 'C:\Windows\System32;C:\Windows',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        TEMP: process.env.TEMP ?? 'C:\Windows\Temp',
        TMP: process.env.TMP ?? 'C:\Windows\Temp',
        USERPROFILE: process.env.USERPROFILE ?? 'C:\Users\Public',
        [CAP_SID_ENV_KEY]: capSid,
      }))
      return executor.run(input, events, signal)
    },
  }
  const memoryStore = new MemoryStore(join(userData, 'data', 'memories.json'))
  const globalMemoryStore = new GlobalMemoryStore(join(userData, 'daweige', 'memory'), emitAgentEvent)
  const reminderService = new ReminderService(() => globalMemoryStore.listReminderRecords().catch(() => []))
  let managerOrchestrator: ManagerOrchestrator | undefined
  // 工作区租约门(0.4.0 D,codex 阶段复审阻断整改):普通/manager 会话的写与命令不得碰被占根
  const workspaceLeaseService = roleRepository ? new WorkspaceLeaseService(roleRepository) : undefined
  // command/collab E2E:faux 模型多步脚本(发起工具调用→收到结果后收尾)。
  // 只 fake 模型流与 OS spawn;agent loop/事件流/Policy/审批/工具编排全真。
  // collab 场景的工具参数由测试经 env 传入(seed 时定死的 runId/角色/目录)。
  const fauxModelsForScenario = (() => {
    const authoredMarkdown = [
      '---',
      'name: reusable-cleanup',
      'description: 整理重复文件并核对结果的同类任务。',
      '---',
      '',
      '# 可复用整理流程',
      '',
      '## 第 0 步',
      '',
      '- 确认目标文件夹和保留规则。',
      '',
      '## 步骤',
      '',
      '1. 按名称和大小找出重复项。',
      '2. 列出拟保留和拟移除清单。',
      '3. 核对数量后交付。',
      '',
      '## 交活自检清单',
      '',
      '- [ ] 数量前后一致',
      '- [ ] 没有碰非目标文件',
      '',
      '## 不要做',
      '',
      '- 不猜测用户的保留偏好。',
    ].join('\n')
    if (e2eScenario === 'skill-authoring-happy') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([fauxText('整理已经完成并核对无误。这个做法以后还会复用吗？要的话我可以把它整理成技能，下次遇到类似活直接照着做。')]),
        fauxAssistantMessage([fauxToolCall('read_skill', { name: 'skill-creator' })]),
        fauxAssistantMessage([fauxToolCall('write_file', {
          path: 'daweige-skill://global/reusable-cleanup/SKILL.md', content: authoredMarkdown,
        })]),
        fauxAssistantMessage([fauxText('技能已经写好；新建对话后可用。')]),
        fauxAssistantMessage([fauxToolCall('read_skill', { name: 'reusable-cleanup' })]),
        fauxAssistantMessage([fauxText('新会话已成功读取 reusable-cleanup。')]),
      ])
      return faux
    }
    if (e2eScenario === 'skill-authoring-ordinary') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([fauxText('北京今天适合带伞。')]),
        fauxAssistantMessage([fauxText('已把这句话翻译好了。')]),
        fauxAssistantMessage([fauxText('你好，很高兴见到你。')]),
      ])
      return faux
    }
    if (e2eScenario === 'skill-authoring-direct') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_skill', { name: 'skill-creator' })]),
        fauxAssistantMessage([fauxToolCall('write_file', {
          path: 'daweige-skill://global/reusable-cleanup/SKILL.md', content: authoredMarkdown,
        })]),
        fauxAssistantMessage([fauxText('已按指南产出技能，等你确认写入后新会话可用。')]),
      ])
      return faux
    }
    if (e2eScenario === 'skill-market-happy' || e2eScenario === 'skill-market-script') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([
          fauxText('我先搜索几个合适的纯文字技能，请你亲自选择。'),
          fauxToolCall('search_skills', { query: 'meeting notes', limit: 3 }),
        ]),
        fauxAssistantMessage([
          fauxToolCall('install_skill', { installToken: 'inst_e2e_skill_market_once_0001' }),
        ]),
        fauxAssistantMessage([fauxText(e2eScenario === 'skill-market-happy'
          ? '安装流程已经结束；请新建对话后使用这个技能。'
          : '这个候选依赖脚本，因此没有安装。')]),
        ...(e2eScenario === 'skill-market-happy' ? [
          fauxAssistantMessage([fauxToolCall('read_skill', { name: 'faux-second' })]),
          fauxAssistantMessage([fauxText('旧会话按冻结快照没有这个技能。')]),
          fauxAssistantMessage([fauxToolCall('read_skill', { name: 'faux-second' })]),
          fauxAssistantMessage([fauxText('新会话已经成功读取 faux-second 技能。')]),
        ] : []),
      ])
      return faux
    }
    if (e2eScenario === 'skill-market-offline') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('search_skills', { query: 'offline', limit: 3 })]),
        fauxAssistantMessage([fauxText('现在连不上技能平台，聊天仍可继续。')]),
      ])
      return faux
    }
    if (e2eScenario === 'command-happy') {
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([
          fauxText('我先跑条只读命令,统计一下这个文件夹里的行数。'),
          fauxToolCall('run_command', { command: 'python summarize.py' }),
        ]),
        fauxAssistantMessage([fauxText('看完了:合计 42 行,共 3 个文件,都在预算内。')]),
      ])
      return faux
    }
    if (e2eScenario === 'collab-followup') {
      const runId = process.env.DAWEIGE_E2E_RUN_ID ?? ''
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([
          fauxText('收到,我把这句补充要求转给正在干活的角色。'),
          fauxToolCall('followup_task', { runId, message: '顺便把汇总表也核对一遍,数字和明细对不上要标出来。' }),
        ]),
        fauxAssistantMessage([fauxText('补充要求已经送达,它会在当前步骤结束后看到。')]),
      ])
      return faux
    }
    if (e2eScenario === 'collab-pipeline') {
      const sourceRunId = process.env.DAWEIGE_E2E_RUN_ID ?? ''
      const targetRoleId = process.env.DAWEIGE_E2E_TARGET_ROLE ?? ''
      const targetWorkspace = process.env.DAWEIGE_E2E_WS_B ?? ''
      const faux = fauxProvider({ tokensPerSecond: 10000 })
      faux.setResponses([
        fauxAssistantMessage([
          fauxText('账房已经汇总完,我把它的定论交给小编写通报。'),
          fauxToolCall('send_message', {
            sourceRunIds: [sourceRunId],
            targetRoleId,
            managerConclusion: '以账房汇总数据为准,数字不许改。',
            taskBrief: '把账房的汇总写成一篇门店通报,面向店长。',
            acceptanceCriteria: ['数字与汇总一致', '有标题和正文'],
            allowedWorkspacePaths: [targetWorkspace],
          }),
        ]),
        fauxAssistantMessage([fauxText('已交棒并派出小编,确认卡等用户批准,批准后它就开始写。')]),
      ])
      return faux
    }
    return undefined
  })()
  const commandFauxModels = fauxModelsForScenario
    ? (() => {
        const fauxModels = createModels()
        fauxModels.setProvider(fauxModelsForScenario.provider)
        const fauxModel = fauxModelsForScenario.getModel()
        return {
          getModel: () => fauxModel,
          streamSimple: (
            model: Parameters<typeof fauxModels.streamSimple>[0],
            context: Parameters<typeof fauxModels.streamSimple>[1],
            options: Parameters<typeof fauxModels.streamSimple>[2],
          ) => fauxModels.streamSimple(model, context, options),
          completeSimple: (
            model: Parameters<typeof fauxModels.completeSimple>[0],
            context: Parameters<typeof fauxModels.completeSimple>[1],
            options: Parameters<typeof fauxModels.completeSimple>[2],
          ) =>
            fauxModels.completeSimple(model, context, options),
        }
      })()
    : undefined
  const configuredAgentModels: AgentModels = commandFauxModels ?? {
      getModel: (providerId, modelId) =>
        providerRegistry.getModel(
          providerId as Parameters<typeof providerRegistry.getModel>[0],
          modelId,
        ),
      streamSimple: (model, context, options) =>
        providerRegistry.models.streamSimple(model, context, options),
      completeSimple: (model, context, options) =>
        providerRegistry.models.completeSimple(model, context, options),
    }
  const usageRecorder = usageService
    ? {
        recordAssistantMessage: (input: Parameters<UsageService['recordAssistantMessage']>[0]) => usageService?.recordAssistantMessage(input),
        recordCompactionEntry: (input: Parameters<UsageService['recordCompactionEntry']>[0]) => usageService?.recordCompactionEntry(input),
        recordAuxiliaryUsage: (input: Parameters<UsageService['recordAuxiliaryUsage']>[0]) => usageService!.recordAuxiliaryUsage(input),
      }
    : undefined
  const memoryConsolidation = new MemoryConsolidationService(globalMemoryStore, {
    models: configuredAgentModels,
    ...(usageRecorder ? { usageRecorder } : {}),
    logError: (message, error) => console.error(
      `[memory] ${message}:`,
      redactCommonSecrets(error instanceof Error ? error.message : String(error)),
    ),
  })
  memoryConsolidationRef = memoryConsolidation
  const agentService = new AgentService({
    models: configuredAgentModels,
    sessionService,
    emitEvent: emitAgentEvent,
    toolchain: async ({ sessionId, workspacePath }) => {
      const binding = roleRepository
        ? await roleRepository.getBinding(sessionId)
        : undefined
      const row = binding && roleRepository
        ? await roleRepository.getRoleRow(binding.roleId)
        : undefined
      const memorySource = {
        kind: 'conversation' as const,
        roleId: binding?.roleId ?? null,
        roleDisplayName: row?.displayName ?? '大微阁',
      }

      /** 0.4.0 C3:按会话构造 run_command 工具(写根 real 快照+capability 钥匙)。 */
      const makeRunCommandToolFor = async (
        roots: readonly string[],
        opts: {
          readonly strictPolicy?: PathPolicy
          readonly scopeId?: string
          readonly surfaceSessionId?: string
          readonly assertNotLeased?: () => Promise<void>
        } = {},
      ) => {
        const realRoots = (await Promise.all(roots.map((r) => realpath(r)))).filter(
          (r, i, arr) => arr.indexOf(r) === i,
        )
        if (realRoots.length === 0) return undefined
        const primaryRoot = realRoots[0] as string
        const capSid = await capabilityStore.sidForRoot(primaryRoot)
        return createRunCommandTool({
          sessionId,
          ...(opts.surfaceSessionId ? { surfaceSessionId: opts.surfaceSessionId } : {}),
          broker: approvalBroker,
          cache: commandApprovalCache,
          executor: sandboxExecutor,
          writableRoots: realRoots,
          defaultCwd: primaryRoot,
          capabilitySid: capSid,
          // 一期保守:每次工具执行独立 turn 作用域(turn 粘性不生效,宁多弹卡不放大授权);
          // 跨回合复用仅经 approve-session 的精确键缓存。
          approvalScopeId: () => `${sessionId}#${Date.now()}#${Math.random()}`,
          scopeId: opts.scopeId ?? '',
          onOutput: (toolCallId, stream, sequence, text) => {
            emitAgentEvent({
              type: 'command_output',
              sessionId,
              toolCallId,
              stream,
              sequence,
              chunk: text,
              ...(opts.surfaceSessionId ? { surfaceSessionId: opts.surfaceSessionId } : {}),
            })
          },
          onFinished: (toolCallId, result) => {
            emitAgentEvent({
              type: 'command_finished',
              sessionId,
              toolCallId,
              result,
              ...(opts.surfaceSessionId ? { surfaceSessionId: opts.surfaceSessionId } : {}),
            })
          },
          ...(opts.strictPolicy ? { strictPolicy: opts.strictPolicy } : {}),
          ...(opts.assertNotLeased ? { assertNotLeased: opts.assertNotLeased } : {}),
        })
      }

      if (row?.kind === 'manager') {
        const policy = new PathPolicy(workspacePath, userData)
        const ops = new FileOps(policy)
        const runCmd = await makeRunCommandToolFor([workspacePath], {
          assertNotLeased: async () => {
            await workspaceLeaseService?.assertNotLeased([workspacePath])
          },
        })
        return {
          tools: buildTools(
            {
              policy,
              ops,
              trash: (p) => shell.trashItem(p),
              memoryTools: () => createMemoryTools(globalMemoryStore, memorySource),
              marketTools: () => createSkillMarketTools({
                sessionId, registry: skillRegistry, broker: approvalBroker,
                tokens: skillInstallTokens, installations: skillInstallations, catalog: skillCatalog,
              }),
              managedSkillWrite,
              sessionId,
              managerTools: () => managerOrchestrator?.toolsForSession(sessionId) ?? [],
              ...(runCmd ? { runCommandTool: () => runCmd } : {}),
            },
            'manager',
          ),
          beforeToolCall: createApprovalGate({
            broker: approvalBroker,
            sessionId,
            policy,
            managedSkillWrite,
            assertNotLeased: (paths) => workspaceLeaseService!.assertNotLeased(paths),
          }),
        }
      }

      const delegatedRun =
        binding?.visibility === 'internal' && roleRepository
          ? await roleRepository.getAgentRunByInternalSession(sessionId)
          : undefined
      // internal 会话只能通过已绑定 run 执行;孤儿 internal fail closed。
      if (binding?.visibility === 'internal' && !delegatedRun) return { tools: [] }
      const policy = delegatedRun
        ? new StrictDelegationPathPolicy(
            delegatedRun.envelope.allowedWorkspacePaths,
            userData,
            async (violation) => {
              if (!roleRepository) return
              await roleRepository.appendAgentRunBoundaryViolation(
                delegatedRun.runId,
                violation,
              )
              await managerOrchestrator?.noteBoundaryViolation(sessionId)
            },
          )
        : new PathPolicy(workspacePath, userData)
      const ops = new FileOps(policy)
      const runCmd = delegatedRun
        ? await makeRunCommandToolFor(delegatedRun.envelope.allowedWorkspacePaths, {
            strictPolicy: policy,
            scopeId: delegatedRun.runId,
            surfaceSessionId: delegatedRun.managerSessionId,
          })
        : await makeRunCommandToolFor([workspacePath], {
            assertNotLeased: async () => {
              await workspaceLeaseService?.assertNotLeased([workspacePath])
            },
          })
      return {
        tools: buildTools(
          {
            policy,
            ops,
            trash: (p) => shell.trashItem(p),
            memoryTools: () => createMemoryTools(globalMemoryStore, memorySource),
            ...(!delegatedRun ? {
              marketTools: () => createSkillMarketTools({
                sessionId, registry: skillRegistry, broker: approvalBroker,
                tokens: skillInstallTokens, installations: skillInstallations, catalog: skillCatalog,
              }),
              managedSkillWrite,
              sessionId,
            } : {}),
            roleRulesTools: () =>
              roleRepository && roleService
                ? [createEditRoleGuardrailsTool({ sessionId, roleRepository, roleService })]
                : [],
            ...(runCmd ? { runCommandTool: () => runCmd } : {}),
          },
          delegatedRun ? 'delegated-worker' : 'regular-worker',
        ),
        beforeToolCall: createApprovalGate({
          broker: approvalBroker,
          sessionId,
          policy,
          ...(delegatedRun
            ? { surfaceSessionId: delegatedRun.managerSessionId }
            : { assertNotLeased: (paths) => workspaceLeaseService!.assertNotLeased(paths) }),
          ...(delegatedRun
            ? { onApprovalPending: (waiting: boolean) => managerOrchestrator?.markChildApproval(sessionId, waiting) }
            : {}),
          getRoleDisplayName: roleRepository
            ? async () => {
                const binding = await roleRepository!.getBinding(sessionId)
                if (!binding) return undefined
                const row = await roleRepository!.getRoleRow(binding.roleId)
                return row?.displayName
              }
            : undefined,
          ...(!delegatedRun ? { managedSkillWrite } : {}),
        }),
      }
    },
    rolePrompt: roleRepository
      ? async (sessionId): Promise<RolePromptLayer | undefined> => {
          if (!roleRepository || !roleService) return undefined
          try {
            const binding = await roleRepository.getBinding(sessionId)
            if (!binding) return undefined
            const row = await roleRepository.getRoleRow(binding.roleId)
            if (row?.kind === 'manager') return undefined
            const { text } = await roleService.readGuardrailsOf(binding.roleId)
            return {
              roleId: binding.roleId,
              displayName: row?.displayName ?? '',
              templateId: (row?.templateId ?? 'legacy-empty') as RolePromptLayer['templateId'],
              guardrails: text,
            }
          } catch (err) {
            // 角色库/守则文件读取失败:转成带中文指引的 PromptComposerError,
            // 经 mapAgentError 直达用户(初审整改:不能落到通用"出了点问题")
            if (err instanceof Error && err.name === 'RoleError') {
              const { PromptComposerError } = await import('./agent/prompt-composer')
              throw new PromptComposerError(
                '角色的守则文件读不到,可能是数据目录损坏;请打开这个角色的守则编辑页检查后再发消息',
              )
            }
            throw err
          }
        }
      : undefined,
    skillContext: async (sessionId) => {
      if (!roleRepository) return skillCatalog.sessionContext()
      const binding = await roleRepository.getBinding(sessionId)
      if (!binding) return skillCatalog.sessionContext()
      const row = await roleRepository.getRoleRow(binding.roleId)
      if (!row) return skillCatalog.sessionContext()
      return skillCatalog.sessionContext({
        roleId: row.id,
        roleDisplayName: row.displayName,
        templateId: row.templateId,
      })
    },
    orchestrationPrompt: roleRepository
      ? async (sessionId) => {
          if (!roleRepository) return {}
          const binding = await roleRepository.getBinding(sessionId)
          if (!binding) return {}
          if (binding.roleId === SYSTEM_MANAGER_ROLE_ID && binding.visibility === 'user') {
            if (!roleService) return { manager: { workers: [] } }
            const summaries = await roleService.listSummaries()
            return {
              manager: {
                workers: summaries.map((summary) => ({
                  roleId: summary.id,
                  displayName: summary.displayName,
                  templateId: summary.templateId,
                  kind: summary.kind,
                  lifecycle: summary.lifecycle,
                  archivedAt: summary.archivedAt,
                  mounts: summary.mounts.map((mount) => ({
                    workspacePath: mount.workspacePath,
                    availability: mount.availability,
                  })),
                })),
              },
            }
          }
          if (binding.visibility === 'internal') {
            const run = await roleRepository.getAgentRunByInternalSession(sessionId)
            if (!run) return {}
            return {
              delegation: { envelope: run.envelope },
              workspacePaths: run.envelope.allowedWorkspacePaths,
            }
          }
          return {}
        }
      : undefined,
    memoryPrompt: createMemoryPromptProvider(globalMemoryStore, (message) => console.warn(message)),
    memoryConsolidation,
    thinkingLevel: () => settingsStore.current()?.thinkingLevel,
    // 0.4.0 A(A-14):manager 会话 effective cwd 覆盖(迁移后旧会话立即指向新工作区)
    managerCwdOverride: (sessionId) => sessionService.managerCwdOverride(sessionId),
    // 转发对象而非直传 usageService:断开两者初始化的类型循环(闭包运行时求值);
    // 统计降级(usageService=undefined)时跳过记录
    usageRecorder,
  })
  agentServiceRef = agentService

  await Promise.all([credentialStore.init(), settingsStore.load(), sessionRepository.init()])
  await globalMemoryStore.initialize(memoryStore).catch((err) => {
    console.error('[memory] 全局记忆初始化失败,本次关闭记忆功能:', redactCommonSecrets(err instanceof Error ? err.message : String(err)))
  })

  // 0.2.0 启动迁移(PLAN §4.1):会话库初始化后、IPC/窗口前;
  // 失败不拦启动(角色降级为空,会话照旧可开);migrationError 经 bootstrap 告知用户(专审整改)
  let migrationError: string | undefined
  let managerBootstrap: ManagerBootstrap | null = null
  let agentRunQuery: AgentRunQueryService | undefined
  let managerCleanup: ManagerCleanupService | undefined
  let e2eAwaitingRunIds: string[] = []
  // 全局默认技能不依赖角色库；必须先补齐，再进行任何角色默认技能迁移。
  try {
    await seedDefaultGlobalSkills(userData)
  } catch (err) {
    console.error(
      '[skills] 全局默认技能补齐失败,不影响聊天与用户技能:',
      redactCommonSecrets(err instanceof Error ? err.message : String(err)),
    )
  }
  if (roleRepository && roleService) {
    try {
      const migration = new RoleMigration(userData, roleRepository, sessionRepository)
      await migration.run()
    } catch (err) {
      console.error(
        '[roles] 启动迁移失败,本次运行关闭角色功能(旧会话不丢):',
        redactCommonSecrets(err instanceof Error ? err.message : String(err)),
      )
      migrationError = '旧会话的角色归组没有完成,本次先不显示角色(旧会话和记录都还在,没有丢)。重启应用会自动重试;若反复出现请反馈。'
      // 只降级角色功能:roleService 置空(toolchain/rolePrompt/handlers 全部判空走无角色分支);
      // SessionService 同步停用角色分支(它持有构造时捕获的引用,初审整改"降级双轨");
      // roleRepository 保留连接供 before-quit 统一关闭,闭包内不再单独关
      roleService = undefined
      sessionService.deactivateRoles()
    }
    if (roleService) {
      try {
        await Promise.all((await roleRepository.listRoleRows()).map((row) =>
          mkdir(join(userData, 'daweige', 'agents', row.id, 'memory'), { recursive: true }),
        ))
      } catch (err) {
        console.error(
          '[memory] 角色记忆预留目录补齐失败,不影响全局记忆:',
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
      }
      try {
        await seedExistingDefaultSkills(
          userData,
          (await roleRepository.listRoleRows()).map((row) => ({
            id: row.id,
            templateId: row.templateId as import('../shared/domain/role').RoleTemplateId,
          })),
        )
      } catch (err) {
        console.error(
          '[skills] 既有角色默认技能补齐失败,不影响聊天与用户技能:',
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
      }
      agentRunQuery = new AgentRunQueryService(
        roleRepository,
        sessionService,
        agentService,
        usageStore,
      )
      const scriptedScenarios = new Set([
        'manager-happy', 'manager-boundary', 'manager-crash',
        'collab-pipeline', 'collab-parallel', 'collab-followup', 'collab-interrupt',
      ])
      const turnRunner: AgentTurnRunner = e2eScenario && scriptedScenarios.has(e2eScenario)
          ? new ScriptedAgentTurnRunner(
            e2eScenario === 'collab-pipeline' || e2eScenario === 'collab-parallel' ||
              e2eScenario === 'collab-followup' || e2eScenario === 'collab-interrupt'
              ? 'collab-hang'
              : e2eScenario as 'manager-happy' | 'manager-boundary' | 'manager-crash',
            async (sessionId) => {
              const run = await roleRepository.getAgentRunByInternalSession(sessionId)
              if (!run) return
              await roleRepository.appendAgentRunBoundaryViolation(run.runId, {
                path: 'C:\\daweige-e2e-outside\\blocked.txt',
                toolName: 'write_file',
                operation: 'write',
                reason: '路径不在本次派活允许的文件夹内',
                occurredAt: Date.now(),
              })
            },
            async (input, finalText) => {
              const session = await sessionService.openPiSession(input.sessionId)
              const at = Date.now()
              await session.appendMessage({ role: 'user', content: input.text, timestamp: at })
              const assistant: AssistantMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: finalText }],
                api: 'anthropic-messages',
                provider: input.selection.providerId,
                model: input.selection.modelId,
                usage: {
                  input: 120,
                  output: 80,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 200,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: 'stop',
                timestamp: at + 1,
              }
              const entryId = await session.appendMessage(assistant)
              const timeZone = currentIanaTimeZone()
              await usageStore?.insertEvents([{
                sourceEntryId: entryId,
                sessionId: input.sessionId,
                provider: input.selection.providerId,
                modelId: input.selection.modelId,
                responseModelId: input.selection.modelId,
                inputTokens: 120,
                outputTokens: 80,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                cacheWrite1hTokens: null,
                totalTokens: 200,
                occurredAtMs: at + 1,
                localDate: localDateFor(at + 1, timeZone),
                timezoneId: timeZone,
                stopReason: 'stop',
              }], 'live')
            },
          )
        : agentService
      managerOrchestrator = new ManagerOrchestrator({
        roles: roleRepository,
        sessions: sessionService,
        approvals: approvalBroker,
        worker: new WorkerRunner(turnRunner),
        query: agentRunQuery,
        userDataPath: userData,
        selection: async (roleId) => resolveRoleModel(await settingsStore.load(), roleId).selection,
        emitEvent: emitAgentEvent,
        isPackaged: app.isPackaged,
      })
      managerOrchestratorRef = managerOrchestrator
      managerCleanup = new ManagerCleanupService(
        roleRepository,
        sessionService,
        agentService,
        approvalBroker,
      )
      roleService.setManagerCleanup(managerCleanup)
      usageService?.setDelegationProvider(() => agentRunQuery!.listAll())
      // 上次删除未完成的 job 幂等续跑:失败只记日志(角色已留 delete_failed,下次启动再试),
      // 绝不因单个删除未完成而禁用整个角色功能(初审阻断项整改)
      await roleService.resumeDeletionJobs({
        interruptSession: (sessionId) => agentService.disposeAgent(sessionId),
        settleApprovals: (sessionId) => {
          approvalBroker.abortAllForSession(sessionId, '角色删除续跑,本次未执行')
          approvalBroker.clearSessionGrants(sessionId)
        },
        removeSession: (sessionId) => sessionService.remove(sessionId),
      })
      // 0.3.0:旧会话迁移与删除续跑完成后再种小柊,避免旧无 binding 会话误归 manager。
      try {
        const settings = await settingsStore.load()
        managerBootstrap = await new ManagerSeedService(
          userData,
          roleRepository,
          sessionService,
          () => managerWorkspaceResolver.configuredOverride() !== undefined,
        ).ensure(settings.providerSelection)
      } catch (err) {
        console.error(
          '[manager] 小柊启动种子失败,本次仅关闭总管入口(旧角色与会话不受影响):',
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
        migrationError ??=
          '小柊这次没有准备好,普通角色和旧会话仍可使用。重启应用会自动重试;若反复出现请反馈。'
      }
      // 0.4.0 D collab E2E:awaiting run 不被启动恢复吞掉,resume 夹具接管确认链
      const collabScenarios = new Set(['collab-pipeline', 'collab-parallel', 'collab-followup', 'collab-interrupt'])
      const preserveAwaiting = e2eScenario === 'manager-happy' ||
        e2eScenario === 'manager-boundary' ||
        (e2eScenario !== undefined && collabScenarios.has(e2eScenario))
      try {
      const recovered = await new AgentRunRecovery(roleRepository, sessionService).reconcileOnStartup({
        preserveAwaitingApproval: preserveAwaiting,
      })
        if (recovered.interrupted > 0 || recovered.removedOrphans > 0) {
          console.info(`[manager] 启动恢复完成：中断派活 ${recovered.interrupted} 条，清理孤儿内部会话 ${recovered.removedOrphans} 条`)
        }
      } catch (err) {
        console.error(
          '[manager] 上次派活的收尾清理未完成,不影响使用:',
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
      }
      if (preserveAwaiting) {
        e2eAwaitingRunIds = (await roleRepository.listAgentRuns())
          .filter((run) => run.status === 'awaiting-approval')
          .map((run) => run.runId)
      }
    }
  }

  installCspHeader(devServerUrl)
  installIpcGate()

  registerAppHandlers({
    settingsStore,
    credentialStore,
    sessionService,
    reminderService,
    roleService,
    migrationError,
    manager: managerBootstrap,
  })
  registerCredentialHandlers(credentialStore, connectivityService)
  registerSettingsHandlers(settingsStore, roleRepository)
  // 0.4.0 A(A-14):总管工作区迁移(选择器授权票据+全量拷贝+校验,防绕过/防半迁移)
  registerManagerWorkspaceHandlers({
    migration: new ManagerWorkspaceMigrationService(managerWorkspaceResolver, settingsStore),
    workspaceAuth,
  })
  registerSessionHandlers(sessionService, agentService, approvalBroker, managerCleanup, settingsStore)
  if (roleService) {
    registerRoleHandlers({
      roleService,
      sessionService,
      agentService,
      approvalBroker,
      workspaceAuth,
    })
  }
  registerWorkspaceHandlers(workspaceAuth, sessionService)
  registerMessageHandlers(agentService, settingsStore, approvalBroker, credentialStore, sessionService)
  registerAgentRunHandlers(agentRunQuery, {
    roles: roleRepository ?? undefined,
    agent: agentService,
    broker: approvalBroker,
    emitEvent: emitAgentEvent,
    onRunInterrupted: () => managerOrchestratorRef?.notifySchedule(),
  })
  registerApprovalHandlers(approvalBroker)
  registerWindowHandlers()
  registerSkillHandlers(skillCatalog)
  registerMemoryHandlers(globalMemoryStore)
  registerUpdateHandlers(updateService)
  if (usageService) {
    registerUsageHandlers(usageService)
    // 历史用量回填:异步幂等,不阻塞窗口;完成/增量后经 usage_updated 通知统计页
    usageService.startBackfill()
  }

  createMainWindow()
  if (managerOrchestrator && e2eAwaitingRunIds.length > 0) {
    // 等 renderer 完成事件订阅，测试夹具才重新发出真实 delegation confirmation。
    setTimeout(() => {
      for (const runId of e2eAwaitingRunIds) {
        void managerOrchestrator?.resumeAwaitingRunForE2E(runId).catch((error) => {
          console.error('[manager-e2e] 待确认夹具恢复失败:', error instanceof Error ? error.message : error)
        })
      }
    }, 1_000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  // 等存储队列收尾再真正退出(计划口径"退出前等待 drain";超时兜底防挂)
  event.preventDefault()
  approvalBrokerRef?.abortAll('应用即将退出,本次未执行')
  managerOrchestratorRef?.stopAccepting()
  const settle = (async () => {
    await managerOrchestratorRef?.drain()
    await agentServiceRef?.drain()
    await memoryConsolidationRef?.drain()
    await Promise.allSettled([
      sessionRepository?.close(),
      usageServiceRef?.drainAndClose(),
      roleRepositoryRef?.drainAndClose(),
    ])
  })()
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000))
  void Promise.race([settle, timeout]).finally(() => {
    app.quit()
  })
})

app.on('window-all-closed', () => {
  uninstallIpcGate()
  if (process.platform !== 'darwin') app.quit()
})
