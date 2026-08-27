import type { ProviderSelection } from './provider'

/**
 * 非敏感设置(持久化到 userData 下的 JSON)。
 * 铁律:Settings 里绝不出现任何 API key / 凭据内容。
 */

export interface WindowBounds {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
  readonly maximized: boolean
}

/** 思考强度档位(取三家 provider 支持档位的并集;off=不思考,默认)。 */
export const THINKING_LEVELS = ['off', 'low', 'high'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

export interface Settings {
  /** 上次选择的厂商+模型;新会话继承。 */
  readonly providerSelection: ProviderSelection
  /**
   * 已启用的模型池(A-23,多选):设置页勾选、对话区右下角切换器从这里选。
   * 缺省/为空时前端回退只显示 providerSelection 一项(老数据兼容)。
   */
  readonly enabledModels?: readonly ProviderSelection[]
  readonly windowBounds?: WindowBounds
  /** 上次活跃会话;启动时据此恢复(无则进空状态)。 */
  readonly lastActiveSessionId?: string
  /** 思考强度(输入框右下角选择);缺省视为 off。 */
  readonly thinkingLevel?: ThinkingLevel
  /**
   * 小柊(总管)工作区覆盖路径(绝对路径)。
   * 缺省=userData 下的内置默认路径。只允许 managerWorkspace:migrate 迁移服务写入;
   * settings:update 携带不同值会被拒绝(EINVALID_REQUEST),防止绕过搬迁流程。
   */
  readonly managerWorkspacePath?: string
}
