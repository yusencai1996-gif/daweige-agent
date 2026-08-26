import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
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
import {
  SYSTEM_MANAGER_ROLE_ID,
  type ManagerBootstrap,
} from '../shared/domain/manager'
import { ProviderRegistry } from './agent/provider-registry'
import { ConnectivityService } from './agent/connectivity-service'
import { AgentService } from './agent/agent-service'
import { ApprovalBroker } from './agent/approval-broker'
import { createApprovalGate } from './agent/approval-gate'
import { buildTools } from './agent/tool-registry'
import { createMemoryTools } from './agent/tools/memory-tools'
import { createEditRoleGuardrailsTool } from './agent/tools/edit-role-guardrails'
import type { RolePromptLayer } from './agent/prompt-composer'
import { PathPolicy, StrictDelegationPathPolicy } from './files/path-policy'
import { FileOps } from './files/file-ops'
import { MemoryStore } from './memory/memory-store'
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
import { registerApprovalHandlers } from './ipc/approval-handlers'
import { registerWindowHandlers } from './ipc/window-handlers'
import { registerMemoryHandlers } from './ipc/memory-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerAgentRunHandlers } from './ipc/agent-run-handlers'
import { WorkerRunner } from './manager/worker-runner'
import { ManagerOrchestrator } from './manager/manager-orchestrator'
import { AgentRunQueryService } from './manager/agent-run-query-service'
import { AgentRunRecovery } from './manager/agent-run-recovery'
import { ManagerCleanupService } from './manager/manager-cleanup-service'
import { ScriptedAgentTurnRunner } from './manager/scripted-agent-turn-runner'
import type { AgentTurnRunner } from './agent/agent-service'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { currentIanaTimeZone, localDateFor } from './usage/usage-parser'
import { UpdateService } from './update/update-service'
import { WorkspaceAuthorization } from './ipc/workspace-auth'

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
// 避免测试建删角色污染真实开发库;正常启动不设此变量,不受影响
if (process.env.DAWEIGE_USER_DATA) {
  app.setPath('userData', process.env.DAWEIGE_USER_DATA)
}

let sessionRepository: SessionRepository | undefined
let roleRepositoryRef: RoleRepository | undefined
let approvalBrokerRef: ApprovalBroker | undefined
let usageServiceRef: UsageService | undefined
let managerOrchestratorRef: ManagerOrchestrator | undefined
let quitting = false

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const credentialStore = new CredentialStore({
    safeStorage: createElectronSafeStorage(),
    secretsDir: join(userData, 'secrets'),
  })
  const settingsStore = new SettingsStore(join(userData, 'settings.json'))
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
  const sessionService = new SessionService(sessionRepository, roleRepository, roleService, userData)
  const providerRegistry = new ProviderRegistry(credentialStore)
  const connectivityService = new ConnectivityService(providerRegistry, credentialStore)

  const emitAgentEvent = (event: AgentPushEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(PUSH_CHANNELS[0], event)
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
      iterateMessageEntries: () => repo.iterateMessageEntries(),
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
  const updateService = new UpdateService({ emitEvent: emitAgentEvent })
  approvalBrokerRef = approvalBroker
  const workspaceAuth = new WorkspaceAuthorization()
  const memoryStore = new MemoryStore(join(userData, 'data', 'memories.json'))
  const reminderService = new ReminderService(() => memoryStore.load())
  let managerOrchestrator: ManagerOrchestrator | undefined
  const agentService = new AgentService({
    models: {
      getModel: (providerId, modelId) =>
        providerRegistry.getModel(
          providerId as Parameters<typeof providerRegistry.getModel>[0],
          modelId,
        ),
      streamSimple: (model, context, options) =>
        providerRegistry.models.streamSimple(model, context, options),
    },
    sessionService,
    emitEvent: emitAgentEvent,
    toolchain: async ({ sessionId, workspacePath }) => {
      const binding = roleRepository
        ? await roleRepository.getBinding(sessionId)
        : undefined
      const row = binding && roleRepository
        ? await roleRepository.getRoleRow(binding.roleId)
        : undefined
      if (row?.kind === 'manager') {
        const policy = new PathPolicy(workspacePath, userData)
        const ops = new FileOps(policy)
        return {
          tools: buildTools(
            {
              policy,
              ops,
              trash: (p) => shell.trashItem(p),
              memoryTools: () => createMemoryTools(memoryStore),
              managerTools: () => managerOrchestrator?.toolsForSession(sessionId) ?? [],
            },
            'manager',
          ),
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
      return {
        tools: buildTools(
          {
            policy,
            ops,
            trash: (p) => shell.trashItem(p),
            memoryTools: () => createMemoryTools(memoryStore),
            roleRulesTools: () =>
              roleRepository && roleService
                ? [createEditRoleGuardrailsTool({ sessionId, roleRepository, roleService })]
                : [],
          },
          delegatedRun ? 'delegated-worker' : 'regular-worker',
        ),
        beforeToolCall: createApprovalGate({
          broker: approvalBroker,
          sessionId,
          policy,
          ...(delegatedRun
            ? { surfaceSessionId: delegatedRun.managerSessionId }
            : {}),
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
    contextNotes: async () => {
      // 隐私边界(复审 B-05):每次对话只告诉模型"记了哪些事"(标题+日期),
      // 不带正文;需要细节时由模型调用 search_memories 按问题检索命中条目。
      const records = await memoryStore.load()
      return records.map((r) => {
        const date =
          r.date?.kind === 'recurring'
            ? `每年${r.date.month}月${r.date.day}日`
            : r.date?.kind === 'fixed'
              ? r.date.iso
              : ''
        return `${r.title}(${r.category}${date ? `,${date}` : ''})`
      })
    },
    thinkingLevel: () => settingsStore.current()?.thinkingLevel,
    // 转发对象而非直传 usageService:断开两者初始化的类型循环(闭包运行时求值);
    // 统计降级(usageService=undefined)时跳过记录
    usageRecorder: usageService
      ? {
          recordAssistantMessage: (input) => usageService?.recordAssistantMessage(input),
          recordMessageSpan: (sessionId, atMs) =>
            usageService?.recordMessageSpan(sessionId, atMs),
        }
      : undefined,
  })

  await Promise.all([credentialStore.init(), settingsStore.load(), sessionRepository.init()])

  // 0.2.0 启动迁移(PLAN §4.1):会话库初始化后、IPC/窗口前;
  // 失败不拦启动(角色降级为空,会话照旧可开);migrationError 经 bootstrap 告知用户(专审整改)
  let migrationError: string | undefined
  let managerBootstrap: ManagerBootstrap | null = null
  let agentRunQuery: AgentRunQueryService | undefined
  let managerCleanup: ManagerCleanupService | undefined
  let e2eAwaitingRunIds: string[] = []
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
      agentRunQuery = new AgentRunQueryService(
        roleRepository,
        sessionService,
        agentService,
        usageStore,
      )
      const e2eScenario = !app.isPackaged && process.env.DAWEIGE_USER_DATA
        ? process.env.DAWEIGE_E2E_SCENARIO
        : undefined
      const scriptedScenarios = new Set(['manager-happy', 'manager-boundary', 'manager-crash'])
      const turnRunner: AgentTurnRunner = e2eScenario && scriptedScenarios.has(e2eScenario)
          ? new ScriptedAgentTurnRunner(
            e2eScenario as 'manager-happy' | 'manager-boundary' | 'manager-crash',
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
        selection: async () => (await settingsStore.load()).providerSelection,
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
        ).ensure(settings.providerSelection)
      } catch (err) {
        console.error(
          '[manager] 小柊启动种子失败,本次仅关闭总管入口(旧角色与会话不受影响):',
          redactCommonSecrets(err instanceof Error ? err.message : String(err)),
        )
        migrationError ??=
          '小柊这次没有准备好,普通角色和旧会话仍可使用。重启应用会自动重试;若反复出现请反馈。'
      }
      try {
        const recovered = await new AgentRunRecovery(roleRepository, sessionService).reconcileOnStartup({
          preserveAwaitingApproval: e2eScenario === 'manager-happy' || e2eScenario === 'manager-boundary',
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
      if (e2eScenario === 'manager-happy' || e2eScenario === 'manager-boundary') {
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
  registerSettingsHandlers(settingsStore)
  registerSessionHandlers(sessionService, agentService, approvalBroker, managerCleanup)
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
  registerAgentRunHandlers(agentRunQuery)
  registerApprovalHandlers(approvalBroker)
  registerWindowHandlers()
  registerMemoryHandlers(memoryStore)
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
