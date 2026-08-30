import { useState } from 'react'
import type {
  CredentialStatus,
  ProviderId,
  ProviderInfo,
  ProviderSelection,
  RoleSummary,
  Settings,
} from '../../../shared/domain'
import type { UpdateState } from '../../../shared/domain/update'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { ConnectivityResult } from '../../../shared/ipc/contracts'
import { MemoryPanel } from './MemoryPanel'
import { AboutPanel } from './AboutPanel'
import { ModelPicker } from './ModelPicker'
import { ManagerWorkspacePanel } from './ManagerWorkspacePanel'
import { RoleDefaultModelPanel } from './RoleDefaultModelPanel'

type SettingsSection = 'keys' | 'memory' | 'workspace' | 'about'

interface SettingsViewProps {
  readonly bridge: DaweigeBridge
  readonly providers: readonly ProviderInfo[]
  readonly credentials: readonly CredentialStatus[]
  readonly onSaveCredential: (providerId: ProviderId, apiKey: string) => Promise<boolean>
  readonly onDeleteCredential: (providerId: ProviderId) => Promise<void>
  readonly onTestCredential: (providerId: ProviderId) => Promise<ConnectivityResult>
  /** 全局当前模型选择(A-10):厂商面板里的模型清单点名字即写回它。 */
  readonly selection: ProviderSelection
  readonly onSelectProvider: (selection: ProviderSelection) => void
  /** 启用池(settings.enabledModels):勾选框勾选态的数据源,空数组=还没勾过。 */
  readonly enabledModels: readonly ProviderSelection[]
  /** 勾选/取消一个常用模型(写 settings.enabledModels 持久化)。 */
  readonly onToggleEnabledModel: (item: ProviderSelection) => void
  /** 角色默认模型面板(A-24):角色列表(含小柊)/现有映射/写入口(走 settings 串行链)。 */
  readonly roles: readonly RoleSummary[]
  readonly roleModelDefaults: Settings['roleModelDefaults']
  readonly onSetRoleDefault: (roleId: string, selection: ProviderSelection | null) => void
  readonly appVersion: string
  readonly updateState: UpdateState
  readonly onCheckUpdate: () => void
  readonly onDownloadUpdate: () => void
  readonly onInstallUpdate: () => void
  readonly onBack: () => void
}

function statusOf(
  credentials: readonly CredentialStatus[],
  providerId: ProviderId,
): CredentialStatus | undefined {
  return credentials.find((c) => c.providerId === providerId)
}

/**
 * 设置页:选厂商 → 填 key → 保存/删除/测试连通。
 * key 输入框掩码显示;保存后立即清空输入框,DOM 里永远不出现完整 key。
 */
export function SettingsView({
  bridge,
  providers,
  credentials,
  onSaveCredential,
  onDeleteCredential,
  onTestCredential,
  selection,
  onSelectProvider,
  enabledModels,
  onToggleEnabledModel,
  roles,
  roleModelDefaults,
  onSetRoleDefault,
  appVersion,
  updateState,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onBack,
}: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>('keys')
  const [selectedId, setSelectedId] = useState<ProviderId>(providers[0]?.id ?? 'kimi-coding')
  const [keyDraft, setKeyDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectivityResult | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)

  const provider = providers.find((p) => p.id === selectedId)
  const status = statusOf(credentials, selectedId)

  const switchProvider = (id: ProviderId) => {
    setSelectedId(id)
    setKeyDraft('')
    setTestResult(null)
    setPanelError(null)
  }

  const save = async () => {
    const key = keyDraft.trim()
    if (key === '' || saving) return
    setSaving(true)
    setPanelError(null)
    setTestResult(null)
    try {
      await onSaveCredential(selectedId, key)
      setKeyDraft('') // 保存成功立刻清掉输入框,完整 key 不留 DOM
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setPanelError(null)
    setTestResult(null)
    try {
      await onDeleteCredential(selectedId)
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error))
    }
  }

  const test = async () => {
    if (testing) return
    setTesting(true)
    setPanelError(null)
    setTestResult(null)
    try {
      const result = await onTestCredential(selectedId)
      setTestResult(result)
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-column">
        <div className="settings-back">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            ← 回到聊天
          </button>
        </div>
        <div className="settings-title">设置</div>

        <div className="provider-tabs" role="tablist" aria-label="设置分区">
          <button
            type="button"
            role="tab"
            aria-selected={section === 'keys'}
            className={section === 'keys' ? 'provider-tab active' : 'provider-tab'}
            onClick={() => setSection('keys')}
          >
            密钥
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'memory'}
            className={section === 'memory' ? 'provider-tab active' : 'provider-tab'}
            onClick={() => setSection('memory')}
          >
            记忆管理
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'workspace'}
            className={section === 'workspace' ? 'provider-tab active' : 'provider-tab'}
            onClick={() => setSection('workspace')}
          >
            总管工作区
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === 'about'}
            className={section === 'about' ? 'provider-tab active' : 'provider-tab'}
            onClick={() => setSection('about')}
          >
            关于与更新
          </button>
        </div>

        {section === 'memory' ? (
          <MemoryPanel bridge={bridge} />
        ) : section === 'workspace' ? (
          <ManagerWorkspacePanel bridge={bridge} />
        ) : section === 'about' ? (
          <AboutPanel
            appVersion={appVersion}
            updateState={updateState}
            onCheckUpdate={onCheckUpdate}
            onDownloadUpdate={onDownloadUpdate}
            onInstallUpdate={onInstallUpdate}
          />
        ) : (
          <>
            <div className="settings-desc">
              key 只存在你自己电脑里,加密保存;这里永远只显示打码后的样子。
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择厂商">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === selectedId}
              className={p.id === selectedId ? 'provider-tab active' : 'provider-tab'}
              onClick={() => switchProvider(p.id)}
            >
              {p.displayName}
            </button>
          ))}
        </div>

        {provider && (
          <div className="cred-panel">
            <div className="cred-panel-title">{provider.displayName}</div>
            <div className="cred-panel-desc">
              {provider.description} · 默认模型 {provider.defaultModelId}
            </div>

            <div
              className={
                status?.configured ? 'cred-status configured' : 'cred-status'
              }
              role="status"
            >
              <span className="cred-status-dot" aria-hidden="true" />
              {status?.configured
                ? `已保存 key:${status.maskedKey}${status.ephemeral ? '(仅本次运行有效,系统加密暂不可用)' : ''}`
                : '还没填 key'}
            </div>

            <div className="form-row">
              <label className="form-label" htmlFor="api-key-input">
                {status?.configured ? '换一个新 key' : '填入 key'}
              </label>
              <input
                id="api-key-input"
                type="password"
                className="text-input"
                value={keyDraft}
                autoComplete="new-password"
                placeholder="粘贴你的 API key,这里只当密码显示"
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <span className="form-tip">保存后这里会清空,页面上不会留下完整 key。</span>
            </div>

            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={saving || keyDraft.trim() === ''}
              >
                {saving ? '保存中…' : '保存 key'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void test()}
                disabled={testing || !status?.configured}
                title={status?.configured ? undefined : '先保存 key 才能测'}
              >
                {testing ? '正在测…' : '测试连通'}
              </button>
              {status?.configured && (
                <button type="button" className="btn btn-ghost" onClick={() => void remove()}>
                  删除 key
                </button>
              )}
            </div>

            {testResult && (
              <div
                className={testResult.ok ? 'test-result ok' : 'test-result fail'}
                role="status"
              >
                <span className="status-dot" aria-hidden="true" />
                <span>{testResult.message}</span>
              </div>
            )}
            {panelError && (
              <div className="test-result fail" role="alert">
                <span className="status-dot" aria-hidden="true" />
                <span>{panelError}</span>
              </div>
            )}

            {/* A-10 改版:模型清单——点名字=设为当前,勾选框=进出启用池;key 随厂商切换重置面板状态 */}
            <ModelPicker
              key={provider.id}
              bridge={bridge}
              provider={provider}
              configured={status?.configured ?? false}
              selection={selection}
              enabledModels={enabledModels}
              onSelectProvider={onSelectProvider}
              onToggleEnabledModel={onToggleEnabledModel}
            />
          </div>
        )}

        {/* A-24:角色默认模型面板(模型区,与厂商凭据面板平级;逐项从启用池选,可「跟随全局」) */}
        <RoleDefaultModelPanel
          roles={roles}
          enabledModels={enabledModels}
          roleModelDefaults={roleModelDefaults}
          providers={providers}
          onSetRoleDefault={onSetRoleDefault}
        />
          </>
        )}
      </div>
    </div>
  )
}
