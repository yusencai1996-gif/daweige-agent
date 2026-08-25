import type { FileOps } from '../../files/file-ops'

/** 工具共享依赖(M4-03~06)。trash 注入 Electron shell.trashItem,便于测试。 */
export interface ToolDeps {
  ops: FileOps
  trash: (path: string) => Promise<void>
}
