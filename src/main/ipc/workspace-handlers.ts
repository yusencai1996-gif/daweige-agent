import { BrowserWindow, dialog } from 'electron'
import { constants } from 'node:fs'
import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ImportedFile } from '../../shared/ipc/contracts'
import { ipcError, registerHandler } from './handler'
import type { SessionService } from '../storage/session-service'
import type { WorkspaceAuthorization } from './workspace-auth'

/**
 * 工作文件夹 IPC(M2-06 + 验收改版:文件导入)。
 * - workspace:choose:系统目录选择器;用户取消返回 null(渲染进程据此不创建空会话)。
 *   选中的路径写入一次性授权(M4 复审 B-02),session:create 消费。
 * - workspace:importFiles:多选文件 → 拷入指定会话的工作文件夹。
 *   用户主动导入=用户意志,免确认卡;重名自动改名(name (1).ext)绝不覆盖既有文件。
 */
export function registerWorkspaceHandlers(
  authorization: WorkspaceAuthorization,
  sessionService: SessionService,
): void {
  registerHandler('workspace:choose', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作文件夹',
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0] ?? null
    if (chosen) {
      await authorization.grant(chosen)
    }
    return chosen
  })

  registerHandler('workspace:importFiles', async ({ sessionId }): Promise<readonly ImportedFile[]> => {
    try {
      await sessionService.assertUserVisibleSession(sessionId)
    } catch (err) {
      throw ipcError(
        'EINVALID_REQUEST',
        err instanceof Error ? err.message : '内部任务会话不能通过普通入口导入文件',
      )
    }
    const summaries = await sessionService.listSummaries()
    const workspacePath = summaries.find((s) => s.id === sessionId)?.workspacePath
    if (!workspacePath || !existsSync(workspacePath)) {
      throw ipcError('ESESSION_NOT_FOUND', '会话不存在或工作文件夹不可用')
    }

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return []
    const picked = await dialog.showOpenDialog(win, {
      title: '选择要导入工作文件夹的文件',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    const imported: ImportedFile[] = []
    for (const src of picked.filePaths) {
      const original = basename(src)
      const stem = extname(original) ? original.slice(0, -extname(original).length) : original
      const ext = extname(original)
      // 独占拷贝(COPYFILE_EXCL):目标已存在直接失败,彻底排除覆盖与 TOCTOU;
      // 撞名则按 (1)(2)… 改名重试,超上限明确报错而非覆盖。
      let importedAs: string | null = null
      for (let i = 0; i <= 999; i += 1) {
        const candidate = i === 0 ? original : `${stem} (${i})${ext}`
        try {
          await copyFile(src, join(workspacePath, candidate), constants.COPYFILE_EXCL)
          importedAs = candidate
          break
        } catch (err) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw err
        }
      }
      if (importedAs === null) {
        throw ipcError('EINVALID_REQUEST', `「${original}」同名文件太多,请清理工作文件夹后重试`)
      }
      imported.push({ fileName: original, importedAs })
    }
    return imported
  })
}
