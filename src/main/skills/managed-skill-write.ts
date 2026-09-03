import type { PreparedSkill, SkillInstallationStore } from './market/skill-installation-store'
import type { SkillCatalogService } from './skill-catalog-service'
import { createHash } from 'node:crypto'

const MANAGED_SKILL_PREFIX = 'daweige-skill:'
const MANAGED_SKILL_URI = /^daweige-skill:\/\/global\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/u
const MAX_SKILL_BYTES = 64 * 1024

export interface ManagedSkillWriteTarget {
  readonly logicalPath: string
  readonly name: string
  readonly markdown: string
  readonly contentSha256: string
}

export interface ManagedSkillWriteResolver {
  resolve(
    logicalPath: string,
    content: string,
    sessionId: string,
  ): Promise<ManagedSkillWriteTarget | undefined>
  approve(target: ManagedSkillWriteTarget, sessionId: string): Promise<void>
  discard(target: ManagedSkillWriteTarget, sessionId: string): Promise<void>
  install(target: ManagedSkillWriteTarget, sessionId: string): Promise<void>
}

interface PendingManagedWrite {
  readonly target: ManagedSkillWriteTarget
  readonly prepared: PreparedSkill
  readonly requestContentSha256: string
  approved: boolean
}

/**
 * write_file 的唯一技能逻辑 URI 解析器。真实路径和 staging 对象只留在主进程内存中。
 */
export class DefaultManagedSkillWriteResolver implements ManagedSkillWriteResolver {
  private readonly pending = new Map<string, PendingManagedWrite>()

  constructor(
    private readonly installations: SkillInstallationStore,
    private readonly catalog: SkillCatalogService,
  ) {}

  async resolve(
    logicalPath: string,
    content: string,
    sessionId: string,
  ): Promise<ManagedSkillWriteTarget | undefined> {
    if (!logicalPath.startsWith(MANAGED_SKILL_PREFIX)) return undefined
    const matched = MANAGED_SKILL_URI.exec(logicalPath)
    if (!matched?.[1]) throw new Error('技能地址格式不合法，只能使用 daweige-skill://global/<name>/SKILL.md。')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes < 1 || bytes > MAX_SKILL_BYTES) throw new Error('技能正文必须为 1..64 KiB 的 UTF-8 Markdown。')

    const key = pendingKey(sessionId, logicalPath)
    const requestContentSha256 = sha256(content)
    const existing = this.pending.get(key)
    if (existing) {
      if (existing.requestContentSha256 === requestContentSha256) return existing.target
      await this.installations.discard(existing.prepared)
      this.pending.delete(key)
    }

    const prepared = await this.installations.prepare({
      markdown: content,
      expectedName: matched[1],
      provenance: { kind: 'authored' },
    })
    try {
      // create-new 在弹卡前就检查；批准后和最终安装前还会各复检一次。
      await this.installations.verifyPrepared(prepared)
    } catch (error) {
      await this.installations.discard(prepared)
      throw error
    }
    const target: ManagedSkillWriteTarget = {
      logicalPath,
      name: prepared.name,
      markdown: prepared.markdown,
      contentSha256: prepared.contentSha256,
    }
    this.pending.set(key, { target, prepared, requestContentSha256, approved: false })
    return target
  }

  async approve(target: ManagedSkillWriteTarget, sessionId: string): Promise<void> {
    const pending = this.requirePending(target, sessionId)
    await this.installations.verifyPrepared(pending.prepared)
    pending.approved = true
  }

  async discard(target: ManagedSkillWriteTarget, sessionId: string): Promise<void> {
    const key = pendingKey(sessionId, target.logicalPath)
    const pending = this.pending.get(key)
    if (!pending || pending.target !== target) return
    this.pending.delete(key)
    await this.installations.discard(pending.prepared)
  }

  async install(target: ManagedSkillWriteTarget, sessionId: string): Promise<void> {
    const key = pendingKey(sessionId, target.logicalPath)
    const pending = this.requirePending(target, sessionId)
    if (!pending.approved) throw new Error('技能写入尚未得到本次确认。')
    try {
      await this.installations.install(pending.prepared)
      this.pending.delete(key)
      await this.catalog.refresh()
    } catch (error) {
      this.pending.delete(key)
      await this.installations.discard(pending.prepared)
      throw error
    }
  }

  private requirePending(target: ManagedSkillWriteTarget, sessionId: string): PendingManagedWrite {
    const pending = this.pending.get(pendingKey(sessionId, target.logicalPath))
    if (!pending || pending.target !== target || pending.target.contentSha256 !== target.contentSha256) {
      throw new Error('技能预览已经失效，请重新发起写入。')
    }
    return pending
  }
}

function pendingKey(sessionId: string, logicalPath: string): string {
  return `${sessionId}\0${logicalPath}`
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
