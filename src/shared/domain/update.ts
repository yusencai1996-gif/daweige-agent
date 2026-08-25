/**
 * 应用更新领域模型(设置页"检查更新")。
 * 状态机:idle → checking → (up-to-date | available) → downloading → ready → install;
 * dev 模式返回 dev-mode;任何异常 fail-closed 为中文错误。
 */

export type UpdateState =
  | { status: 'idle' }
  | { status: 'dev-mode' }
  | { status: 'checking' }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'available'; version: string; currentVersion: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }
