import type { ContractChannel, RequestOf, ResponseOf } from './contracts'
import type { AgentPushEvent } from './events'

/**
 * 渲染进程 ↔ 主进程 的唯一桥接口。
 * 三方实现同一接口:preload(真实)、tests/helpers/mock-bridge(开发/测试)、E2E 注入。
 */

export interface DaweigeBridge {
  /** preload 会对 RESPONSE_SCHEMAS 已冻结的 Gate 1 响应复验后再返回。 */
  invoke<C extends ContractChannel>(
    channel: C,
    payload: RequestOf<C>,
  ): Promise<ResponseOf<C>>
  /** 订阅 agent:event 推送;返回取消订阅函数。 */
  onAgentEvent(listener: (event: AgentPushEvent) => void): () => void
}
