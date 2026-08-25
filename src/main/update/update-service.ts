import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/domain/update'
import type { AgentPushEvent } from '../../shared/ipc/events'
import { applyUpdateProxy } from './proxy'

/**
 * 应用更新服务(设置页"检查更新")。
 * - 打包版启用 electron-updater(generic 源,见 electron-builder.yml publish);
 * - dev 模式不启用(返回 dev-mode);
 * - 状态机:idle → checking → (up-to-date | available) → downloading(progress) → ready → install;
 * - 任何异常 fail-closed 为中文错误,绝不中断应用主流程。
 */

export type { UpdateState }

export interface UpdateServiceDeps {
  emitEvent: (event: AgentPushEvent) => void
}

export class UpdateService {
  private state: UpdateState = { status: 'idle' }
  private updater: AppUpdater | undefined
  private checking = false
  private lastKnownVersion = ''
  private uncaughtHooked = false

  constructor(private readonly deps: UpdateServiceDeps) {}

  /** 惰性加载 electron-updater(仅打包版;dev 下不启用)。 */
  private ensureUpdater(): AppUpdater | undefined {
    if (this.updater) return this.updater
    if (!app.isPackaged) return undefined
    try {
      // 动态 require:dev 依赖图不需要它,类型走静态 import
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 惰性加载 electron-updater 的刻意写法(打包版专用)
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      this.wire(autoUpdater)
      this.hookUncaught()
      this.updater = autoUpdater
      return this.updater
    } catch {
      return undefined
    }
  }

  /**
   * electron-updater 的网络错误(SimpleURLLoader/net::ERR_*)有时不走 'error' 事件,
   * 而是直接抛成进程级 Uncaught Exception(用户会看到英文系统弹窗)。
   * 这里只拦截"更新网络类"错误转成人话状态;其他未知异常原样上抛,保持默认崩溃行为。
   */
  private hookUncaught(): void {
    if (this.uncaughtHooked) return
    this.uncaughtHooked = true
    process.on('uncaughtException', (err: unknown) => {
      const msg = err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err)
      if (msg.includes('net::ERR_') || msg.includes('SimpleURLLoaderWrapper')) {
        this.set({ status: 'error', message: translateUpdateError(msg) })
        return
      }
      // 非更新网络错误:不吞,按默认行为处理(重抛触发崩溃,不掩盖真问题)
      throw err
    })
  }

  private wire(u: AppUpdater): void {
    // u.currentVersion 可能是 semver 对象(非纯字符串):直接进渲染层会触发
    // React #31(对象不能当子节点)导致整树卸载白屏——统一 String() 化。
    const currentVersionText = (): string => String(u.currentVersion ?? '')
    u.on('checking-for-update', () => this.set({ status: 'checking' }))
    u.on('update-available', (info) => {
      this.lastKnownVersion = String(info?.version ?? '')
      this.set({
        status: 'available',
        version: this.lastKnownVersion,
        currentVersion: currentVersionText(),
      })
    })
    u.on('update-not-available', () =>
      this.set({ status: 'up-to-date', currentVersion: currentVersionText() }),
    )
    u.on('download-progress', (p) => {
      this.set({
        status: 'downloading',
        version: this.lastKnownVersion,
        percent: Math.round(p.percent ?? 0),
      })
    })
    u.on('update-downloaded', (info) => {
      const version = String(info?.version ?? '') || this.lastKnownVersion
      this.set({ status: 'ready', version })
    })
    u.on('error', (err) => {
      this.set({
        status: 'error',
        message:
          err instanceof Error ? translateUpdateError(err.message) : '更新出错了,请稍后再试',
      })
    })
  }

  private set(next: UpdateState): void {
    this.state = next
    this.deps.emitEvent({ type: 'update_state', state: next })
  }

  currentState(): UpdateState {
    return this.state
  }

  async check(): Promise<UpdateState> {
    if (this.checking) return this.state
    const u = this.ensureUpdater()
    if (!u) {
      this.set({ status: 'dev-mode' })
      return this.state
    }
    this.checking = true
    this.set({ status: 'checking' })
    // 每次检查前重读系统代理(用户可能中途开关代理;未开则自动直连)
    await applyUpdateProxy().catch(() => {})
    // 跨境线路抖动实测存在:检查失败自动重试 2 次(间隔 2s),全败才报错
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await u.checkForUpdates()
        break
      } catch (err) {
        if (attempt < 3) {
          this.set({ status: 'checking' })
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        this.set({
          status: 'error',
          message:
            err instanceof Error ? translateUpdateError(err.message) : '检查更新失败,请稍后再试',
        })
      }
    }
    this.checking = false
    return this.state
  }

  async download(): Promise<UpdateState> {
    const u = this.ensureUpdater()
    if (!u || this.state.status !== 'available') return this.state
    // 下载前的代理状态可能与检查时不同(用户中途开关代理),重读一次
    await applyUpdateProxy().catch(() => {})
    // 下载失败同样自动重试 2 次;electron-updater 自身支持断点续传,重试从断点继续
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await u.downloadUpdate()
        break
      } catch (err) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        this.set({
          status: 'error',
          message: err instanceof Error ? translateUpdateError(err.message) : '下载更新失败,请稍后再试',
        })
      }
    }
    return this.state
  }

  install(): void {
    const u = this.ensureUpdater()
    if (!u || this.state.status !== 'ready') return
    u.quitAndInstall()
  }
}

/** 常见更新错误 → 人话(未知错误保留原文但截断)。 */
export function translateUpdateError(raw: string): string {
  const s = raw.toLowerCase()
  if (s.includes('err_connection_closed') || s.includes('err_connection_reset'))
    return '网络连接被中途断开(线路波动),再试一次通常就好'
  if (s.includes('err_ssl') || s.includes('err_cert'))
    return '安全连接没建立成功(网络波动),再试一次通常就好'
  if (s.includes('err_timed_out') || s.includes('etimedout'))
    return '连接更新服务器超时,请稍后再试'
  if (s.includes('enotfound') || s.includes('eai_again') || s.includes('network') || s.includes('err_name'))
    return '连不上更新服务器,请检查网络后重试'
  if (s.includes('econnrefused') || s.includes('404') || s.includes('cannot find'))
    return '更新服务暂不可用,请稍后再试'
  if (s.includes('sha') || s.includes('checksum') || s.includes('signature'))
    return '更新包校验失败,已停止安装(可能是下载不完整,请重试)'
  if (s.includes('econnreset') || s.includes('socket'))
    return '下载中断了,请重新点"检查更新"再试'
  return `更新出错了:${raw.slice(0, 80)}`
}
