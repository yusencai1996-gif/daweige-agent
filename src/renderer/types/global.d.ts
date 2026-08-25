import type { DaweigeBridge } from '../../shared/ipc/bridge'
import type { MockBridge } from '../../../tests/helpers/mock-bridge'

declare global {
  interface Window {
    /** 真实 preload 桥(M7 注入);纯 web 开发态为 undefined。 */
    daweige?: DaweigeBridge
    /** 仅开发态:暴露 MockBridge,便于浏览器自测时驱动流式/确认事件。 */
    __daweigeMock?: MockBridge
  }
}

export {}
