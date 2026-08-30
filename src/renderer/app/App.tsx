import { useEffect, useMemo, useState } from 'react'
import type { Settings } from '../../shared/domain'
import type { DaweigeBridge } from '../../shared/ipc/bridge'
import { TitleBar } from '../components/TitleBar'
import { RoleSidebar } from '../features/roles/RoleSidebar'
import { RoleCreateWizard } from '../features/roles/RoleCreateWizard'
import { RoleRulesView } from '../features/roles/RoleRulesView'
import { RoleDeleteDialog } from '../features/roles/RoleDeleteDialog'
import { ArchiveView } from '../features/roles/ArchiveView'
import { ChatView } from '../features/chat/ChatView'
import { SettingsView } from '../features/settings/SettingsView'
import { UsageView } from '../features/usage/UsageView'
import type { GuardrailsDraftCardActions } from '../features/manager/GuardrailsDraftCard'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import { canSaveAsRoleDefault } from '../features/settings/model-options'
import { useAppController } from './use-app-controller'

/** 全局背景三层:纸纹(全屏唯一实例)+ 左右淡墨山,沉在内容之后。 */
function BackgroundLayers() {
  return (
    <>
      <div className="paper-texture" aria-hidden="true" />
      <div className="mountain mountain-left" aria-hidden="true" />
      <div className="mountain mountain-right" aria-hidden="true" />
    </>
  )
}

export function App({ bridge }: { readonly bridge: DaweigeBridge }) {
  const controller = useAppController(bridge)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // 守则页未保存修改:切另一角色守则页前二次确认(dirty 由 RoleRulesView 上报)
  const [rulesDirty, setRulesDirty] = useState(false)
  const [pendingRulesSwitch, setPendingRulesSwitch] = useState<string | null>(null)

  // 修改已保存/被覆盖后,挂起的切换确认一并失效
  useEffect(() => {
    if (!rulesDirty) setPendingRulesSwitch(null)
  }, [rulesDirty])

  const requestOpenRules = (roleId: string) => {
    if (
      controller.view === 'role-rules' &&
      rulesDirty &&
      controller.rulesRoleId !== null &&
      roleId !== controller.rulesRoleId
    ) {
      setPendingRulesSwitch(roleId)
      return
    }
    setPendingRulesSwitch(null)
    void controller.openRoleRules(roleId)
  }

  const confirmRulesSwitch = () => {
    const target = pendingRulesSwitch
    setPendingRulesSwitch(null)
    if (target !== null) void controller.openRoleRules(target)
  }

  /**
   * 守则草稿卡动作(批 2b,PLAN §10.5):卡片只「打开既有界面并本地预填」,
   * 保存/确认仍是用户在既有页面里亲手点——这里不发任何写 IPC。
   *
   * 阻断-3(0.3.0 整改):草稿卡是总管专属交互,只在当前会话绑定小柊(sys-xiaozhen)时传入;
   * 普通 worker 会话拿到 undefined,```daweige-role-draft 块只按普通代码文本渲染,不出卡、无动作。
   * useMemo 稳住引用:否则每次渲染新建对象会让 MessageList 的草稿解析整棵重来。
   */
  const managerSessionActive = controller.activeDetail?.summary.roleId === SYSTEM_MANAGER_ROLE_ID
  const { roles, openRoleRules, openWizard } = controller
  const draftActions: GuardrailsDraftCardActions | undefined = useMemo(
    () =>
      managerSessionActive
        ? {
            roleNameFor: (roleId) => roles.find((r) => r.id === roleId)?.displayName,
            onReviewSave: (draft) => {
              if (draft.targetRoleId !== null) {
                void openRoleRules(draft.targetRoleId, draft.guardrails)
              }
            },
            onCreateWith: (draft) =>
              openWizard({ displayName: draft.displayName, guardrails: draft.guardrails }),
          }
        : undefined,
    [managerSessionActive, roles, openRoleRules, openWizard],
  )

  // 标题栏在最外层:所有界面状态(含启动失败页)都能拖动/关闭窗口
  return (
    <div className="app-root">
      <TitleBar
        bridge={bridge}
        sessionTitle={controller.activeDetail?.summary.title ?? null}
        workspacePath={controller.activeDetail?.summary.workspacePath ?? null}
      />
      {controller.bootstrapError ? (
        <>
          <BackgroundLayers />
          <div className="fullscreen-state">
            <div className="state-title">启动没成功</div>
            <div className="state-desc">{controller.bootstrapError}</div>
            <button type="button" className="btn btn-primary" onClick={controller.retryBootstrap}>
              再试一次
            </button>
          </div>
        </>
      ) : !controller.bootstrap || !controller.settings ? (
        <>
          <BackgroundLayers />
          <div className="fullscreen-state">
            <div className="state-title">大微阁</div>
            <div className="state-desc">正在铺开宣纸…</div>
          </div>
        </>
      ) : (
        <>
          <BackgroundLayers />
          <div className="app-shell">
        <RoleSidebar
          roles={controller.roles}
          sessions={controller.sessions}
          activeSessionId={controller.activeSessionId}
          expandedRoleId={controller.expandedRoleId}
          sessionBusy={controller.sessionBusy}
          open={sidebarOpen}
          notice={controller.notice}
          migrationError={controller.bootstrap.migrationError ?? null}
          managerDegraded={controller.bootstrap.manager === null}
          onClose={() => setSidebarOpen(false)}
          onToggleRole={(roleId) =>
            controller.setExpandedRoleId(controller.expandedRoleId === roleId ? null : roleId)
          }
          onOpenSession={(id) => void controller.openSession(id)}
          onCreateSession={(roleId) => void controller.createSession(roleId)}
          onRenameSession={controller.renameSession}
          onArchiveSession={(id) => void controller.archiveSession(id)}
          onDeleteSession={(id) => void controller.deleteSession(id)}
          // 包一层:onClick 会把 MouseEvent 当 prefill 传进 openWizard(批 2b 起了可选入参)
          onCreateRole={() => controller.openWizard()}
          onOpenRules={requestOpenRules}
          onRenameRole={controller.renameRole}
          onArchiveRole={(roleId) => void controller.archiveRole(roleId)}
          onDeleteRole={controller.openDeleteDialog}
          onOpenArchive={controller.openArchive}
          onOpenSettings={controller.openSettings}
          onOpenUsage={controller.openUsage}
        />
        <main className="main-pane">
          {controller.view === 'settings' ? (
            <SettingsView
              bridge={bridge}
              providers={controller.bootstrap.providers}
              credentials={controller.credentials}
              onSaveCredential={controller.saveCredential}
              onDeleteCredential={controller.deleteCredential}
              onTestCredential={controller.testCredential}
              selection={controller.settings.providerSelection}
              onSelectProvider={(sel) => void controller.selectProvider(sel)}
              enabledModels={controller.settings.enabledModels ?? []}
              onToggleEnabledModel={(item) => void controller.toggleEnabledModel(item)}
              roles={controller.roles}
              roleModelDefaults={controller.settings.roleModelDefaults}
              onSetRoleDefault={(roleId, sel) => void controller.setRoleModelDefault(roleId, sel)}
              appVersion={controller.bootstrap.appVersion}
              updateState={controller.updateState}
              onCheckUpdate={() => void controller.checkUpdate()}
              onDownloadUpdate={() => void controller.downloadUpdate()}
              onInstallUpdate={controller.installUpdate}
              onBack={controller.closeSettings}
            />
          ) : controller.view === 'usage' ? (
            <UsageView bridge={bridge} onBack={controller.closeUsage} />
          ) : controller.view === 'role-rules' ? (
            <RoleRulesView
              detail={controller.rulesDetail}
              loading={controller.rulesLoading}
              prefill={controller.rulesPrefill}
              onSave={controller.saveGuardrails}
              onBack={controller.closeRoleRules}
              onDirtyChange={setRulesDirty}
              switchPending={pendingRulesSwitch !== null}
              onConfirmSwitch={confirmRulesSwitch}
              onCancelSwitch={() => setPendingRulesSwitch(null)}
            />
          ) : controller.view === 'archive' ? (
            <ArchiveView
              roles={controller.roles}
              sessions={controller.sessions}
              onBack={controller.closeArchive}
              onRestoreRole={(roleId) => void controller.restoreRole(roleId)}
              onDeleteRole={controller.openDeleteDialog}
              onRestoreSession={(id) => void controller.restoreSession(id)}
              onDeleteSession={(id) => void controller.deleteSession(id)}
            />
          ) : (
            <ChatView
              bridge={bridge}
              detail={controller.activeDetail}
              detailLoading={controller.detailLoading}
              hasSessions={controller.sessions.length > 0}
              messages={controller.messages}
              agentRuns={controller.agentRuns}
              delegation={controller.delegation}
              collabPanel={controller.collabPanel}
              collabPanelActions={controller.collabPanelActions}
              draftActions={draftActions}
              roleName={controller.activeRoleName}
              streamingMessageId={controller.streamingMessageId}
              approvals={controller.approvals}
              commandLive={controller.commandLive}
              streaming={controller.streaming}
              sending={controller.sending}
              chatError={controller.chatError}
              contextUsage={controller.contextUsage}
              draft={controller.draftFor(controller.activeSessionId)}
              onDraftChange={(text) => controller.setDraft(controller.activeSessionId, text)}
              providers={controller.bootstrap.providers}
              // A-24:右下角切换器显示当前会话生效选择(临时覆盖 > 角色默认 > 全局默认)
              selection={controller.activeModelSelection ?? controller.settings.providerSelection}
              enabledModels={controller.settings.enabledModels}
              thinkingLevel={controller.settings.thinkingLevel ?? 'off'}
              reminders={controller.reminders}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              // A-24:会话内切换只写内存覆盖,不落盘;设置页全局默认走 selectProvider
              onSelectProvider={(selection) => controller.selectSessionProvider(selection)}
              onChangeThinking={(level) => void controller.updateThinkingLevel(level)}
              saveAsRoleDefault={(() => {
                const roleId = controller.activeDetail?.summary.roleId ?? null
                const selection = controller.activeModelSelection
                if (roleId === null || selection === null) return null
                return {
                  roleName: controller.activeRoleName,
                  canSave: canSaveAsRoleDefault(controller.settings as Settings, roleId, selection),
                  onSave: () => void controller.saveActiveModelAsRoleDefault(),
                }
              })()}
              onSend={(text) => void controller.send(text)}
              onAbort={() => void controller.abort()}
              onRetry={() => void controller.retryLast()}
              onRespondApproval={(card, decision, note) =>
                void controller.respondApproval(card, decision, note)
              }
              onDismissReminder={controller.dismissReminder}
              onCreateRole={() => controller.openWizard()}
            />
          )}
        </main>
      </div>

      {controller.wizardOpen && (
        <RoleCreateWizard
          bridge={bridge}
          prefill={controller.wizardPrefill}
          onCancel={controller.closeWizard}
          onSubmit={controller.createRole}
        />
      )}
      {controller.deleteDialogRole && (
        <RoleDeleteDialog
          role={controller.deleteDialogRole}
          getDeleteImpact={controller.getDeleteImpact}
          onDelete={controller.deleteRole}
          onCancel={controller.closeDeleteDialog}
        />
      )}
      </>
      )}
    </div>
  )
}
