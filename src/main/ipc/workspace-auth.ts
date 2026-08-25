import { promises as fs } from 'node:fs'

/**
 * 工作文件夹一次性授权(M4 复审整改 B-02)。
 * 防不可信渲染进程绕过系统目录选择器,直接用 session:create 提交任意目录
 * (如 C:\)导致该目录内读取被闸门视为"工作区内放行"。
 *
 * 流程:workspace:choose 由真实系统选择器返回路径时 grant;
 * session:create 消费(consume)——校验通过即作废,路径不匹配/过期一律拒绝。
 */

const AUTH_TTL_MS = 10 * 60 * 1000

export class WorkspaceAuthorization {
  private readonly allowed = new Map<string, number>()

  /** 系统选择器确认的路径,10 分钟内可用来创建会话。 */
  async grant(path: string): Promise<void> {
    const real = await this.normalize(path)
    if (real) this.allowed.set(real, Date.now() + AUTH_TTL_MS)
  }

  /** 创建会话时校验并作废。 */
  async consume(path: string): Promise<boolean> {
    const real = await this.normalize(path)
    if (!real) return false
    const expiresAt = this.allowed.get(real)
    if (expiresAt === undefined) return false
    this.allowed.delete(real)
    return Date.now() <= expiresAt
  }

  /** 目录必须真实存在;规范化为 realpath 小写形态(与 PathPolicy 同口径)。 */
  private async normalize(path: string): Promise<string | undefined> {
    try {
      const info = await fs.stat(path)
      if (!info.isDirectory()) return undefined
      const real = await fs.realpath(path)
      return real.toLowerCase()
    } catch {
      return undefined
    }
  }
}
