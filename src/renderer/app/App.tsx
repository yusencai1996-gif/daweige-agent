import { useEffect, useState } from 'react'
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
          onClose={() => setSidebarOpen(false)}
          onToggleRole={(roleId) =>
            controller.setExpandedRoleId(controller.expandedRoleId === roleId ? null : roleId)
          }
          onOpenSession={(id) => void controller.openSession(id)}
          onCreateSession={(roleId) => void controller.createSession(roleId)}
          onRenameSession={controller.renameSession}
          onArchiveSession={(id) => void controller.archiveSession(id)}
          onDeleteSession={(id) => void controller.deleteSession(id)}
          onCreateRole={controller.openWizard}
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
              roleName={controller.activeRoleName}
              streamingMessageId={controller.streamingMessageId}
              approvals={controller.approvals}
              streaming={controller.streaming}
              sending={controller.sending}
              chatError={controller.chatError}
              contextUsage={controller.contextUsage}
              draft={controller.draftFor(controller.activeSessionId)}
              onDraftChange={(text) => controller.setDraft(controller.activeSessionId, text)}
              providers={controller.bootstrap.providers}
              selection={controller.settings.providerSelection}
              thinkingLevel={controller.settings.thinkingLevel ?? 'off'}
              reminders={controller.reminders}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              onSelectProvider={(selection) => void controller.selectProvider(selection)}
              onChangeThinking={(level) => void controller.updateThinkingLevel(level)}
              onSend={(text) => void controller.send(text)}
              onAbort={() => void controller.abort()}
              onRetry={() => void controller.retryLast()}
              onRespondApproval={(card, decision, note) =>
                void controller.respondApproval(card, decision, note)
              }
              onDismissReminder={controller.dismissReminder}
              onCreateRole={controller.openWizard}
            />
          )}
        </main>
      </div>

      {controller.wizardOpen && (
        <RoleCreateWizard
          bridge={bridge}
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
