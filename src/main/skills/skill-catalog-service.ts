import {
  formatSkillsForSystemPrompt,
  loadSourcedSkills,
  type AgentTool,
  type Skill,
  type SkillDiagnostic,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  InstalledSkill,
  SkillDiagnosticCode,
  SkillDiagnosticView,
  SkillListSnapshot,
  SkillScope,
  SkillProvenance,
} from '../../shared/domain/skill'
import { createReadSkillTool } from '../agent/tools/read-skill'
import { redactCommonSecrets } from '../security/redaction'
import { roleHomePath } from '../roles/role-files'
import { SYSTEM_MANAGER_ROLE_ID } from '../../shared/domain/manager'
import { systemRoleHomePath } from '../roles/system-manager'
import {
  SkillInstallationStore,
} from './market/skill-installation-store'
import { ensureCanonicalDirectory } from '../security/canonical-containment'

export interface SkillRoleTarget {
  readonly roleId: string
  readonly roleDisplayName: string
  readonly templateId?: string
}

export interface SessionSkillContext {
  readonly generation: number
  readonly promptFragment: string
  readonly tools: readonly AgentTool[]
}

interface EffectiveSkill {
  readonly skill: Skill
  /** 仅用于同层去重、角色覆盖和内置识别，不得跨 UI/模型/工具边界。 */
  readonly originalName: string
  readonly source: SkillScope
  readonly builtIn: boolean
  provenance: SkillProvenance
  readonly installationDir: string
}

interface CatalogResult {
  readonly effective: readonly EffectiveSkill[]
  readonly diagnostics: readonly SkillDiagnosticView[]
}

const BUILT_IN_BY_TEMPLATE: Readonly<Record<string, string>> = {
  accountant: 'multi-sheet-reconcile',
  writer: 'work-report-writing',
  'file-steward': 'files-and-photos-organize',
  'manager-built-in': 'delegation-breakdown',
}
const GLOBAL_BUILT_INS = new Set(['skill-creator'])

export class SkillCatalogService {
  private generationValue = 1
  private readonly cache = new Map<string, Promise<CatalogResult>>()

  constructor(
    private readonly userDataPath: string,
    private readonly listRoles: () => Promise<readonly SkillRoleTarget[]> = async () => [],
  ) {}

  get generation(): number {
    return this.generationValue
  }

  globalSkillsRoot(): string {
    return join(this.userDataPath, 'daweige', 'skills')
  }

  roleSkillsRoot(roleId: string): string {
    const home = roleId === SYSTEM_MANAGER_ROLE_ID
      ? systemRoleHomePath(this.userDataPath)
      : roleHomePath(this.userDataPath, roleId)
    return join(home, 'extensions', 'skills')
  }

  async sessionContext(role?: SkillRoleTarget): Promise<SessionSkillContext> {
    const generation = this.generationValue
    const result = await this.scan(role)
    const skills = result.effective.map((entry) => entry.skill)
    return {
      generation,
      promptFragment: skills.length === 0 ? '' : formatSkillsForSystemPrompt(skills),
      tools: [createReadSkillTool({ skills })],
    }
  }

  async list(): Promise<SkillListSnapshot> {
    const generation = this.generationValue
    const roles = await this.listRoles()
    const scans = await Promise.all([this.scan(undefined), ...roles.map((role) => this.scan(role))])
    const skills = new Map<string, InstalledSkill>()
    const diagnostics: SkillDiagnosticView[] = []
    for (const scan of scans) {
      for (const entry of scan.effective) {
        const installed = toInstalledSkill(entry)
        skills.set(installed.id, installed)
      }
      diagnostics.push(...scan.diagnostics)
    }
    return {
      generation,
      skills: [...skills.values()].sort(compareInstalled),
      diagnostics: dedupeDiagnostics(diagnostics),
      effectiveFrom: 'new-session',
    }
  }

  async uninstall(
    request: { readonly skillId: string; readonly expectedGeneration: number },
    trash: (path: string) => Promise<void>,
  ): Promise<SkillListSnapshot> {
    if (request.expectedGeneration !== this.generationValue) {
      throw new Error('技能列表已经变化，请刷新后再确认卸载。')
    }
    const snapshot = await this.list()
    const skill = snapshot.skills.find((item) => item.id === request.skillId)
    if (!skill) throw new Error('找不到这个技能，请刷新列表后重试。')
    if (!skill.canUninstall || skill.source.kind !== 'global' || (skill.provenance.kind !== 'market' && skill.provenance.kind !== 'authored')) {
      throw new Error('只有由大微阁安装或创作的全局技能可以在这里卸载。')
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name)) throw new Error('技能名称不适合自动卸载，请改为手工管理。')
    const target = join(this.globalSkillsRoot(), skill.name)
    const store = new SkillInstallationStore(this.globalSkillsRoot())
    const verified = await store.verifyForUninstall(target)
    if (verified.record.provenance.kind !== skill.provenance.kind) throw new Error('技能来源记录与列表不一致，已停止卸载。')
    if (verified.hasExtraFiles) {
      throw new Error('目录含你后来添加的内容，本版无法通过冻结契约完成额外一次确认；请先移走这些内容再卸载。')
    }
    await trash(target)
    return this.refresh()
  }

  async refresh(): Promise<SkillListSnapshot> {
    this.generationValue += 1
    this.cache.clear()
    return this.list()
  }

  async openFolder(
    request: { readonly scope: 'global' } | { readonly scope: 'role'; readonly roleId: string },
    openPath: (path: string) => Promise<string>,
  ): Promise<void> {
    let target: string
    if (request.scope === 'global') {
      target = this.globalSkillsRoot()
    } else {
      const role = (await this.listRoles()).find((candidate) => candidate.roleId === request.roleId)
      if (!role) throw new Error('找不到这个角色,技能文件夹没有打开')
      target = this.roleSkillsRoot(role.roleId)
    }
    await ensureCanonicalDirectory(join(this.userDataPath, 'daweige'), target)
    const error = await openPath(target)
    if (error) throw new Error('系统没有打开技能文件夹,请检查目录权限后重试')
  }

  private scan(role: SkillRoleTarget | undefined): Promise<CatalogResult> {
    const key = role ? `role:${role.roleId}` : 'global'
    let pending = this.cache.get(key)
    if (!pending) {
      pending = this.load(role)
      this.cache.set(key, pending)
    }
    return pending
  }

  private async load(role: SkillRoleTarget | undefined): Promise<CatalogResult> {
    const globalSource: SkillScope = { kind: 'global' }
    const inputs: Array<{ path: string; source: SkillScope }> = [
      { path: this.globalSkillsRoot(), source: globalSource },
    ]
    if (role) {
      inputs.push({
        path: this.roleSkillsRoot(role.roleId),
        source: {
          kind: 'role',
          roleId: role.roleId,
          roleDisplayName: redactCommonSecrets(role.roleDisplayName),
        },
      })
    }

    const env = new NodeExecutionEnv({ cwd: this.userDataPath })
    try {
      const loaded = await loadSourcedSkills(env, inputs)
      const diagnostics = loaded.diagnostics.map((diagnostic) =>
        diagnosticView(diagnostic, rootForSource(inputs, diagnostic.source)))
      const candidates: EffectiveSkill[] = []

      for (const item of loaded.skills) {
        const root = rootForSource(inputs, item.source)
        const rootInfo = await env.fileInfo(root)
        if (rootInfo.ok && rootInfo.value.kind === 'symlink') {
          diagnostics.push({
            code: 'outside_root',
            message: '技能根目录是一个链接,已忽略其中技能',
            source: item.source,
          })
          continue
        }
        const canonicalRoot = await canonicalOrResolved(env, root)
        const canonicalFile = await env.canonicalPath(item.skill.filePath)
        if (!canonicalFile.ok || !isWithin(canonicalRoot, canonicalFile.value)) {
          diagnostics.push({
            code: 'outside_root',
            message: '技能文件位于声明目录之外,已忽略',
            source: item.source,
            ...relativeField(root, item.skill.filePath),
          })
          continue
        }
        const displayName = redactCommonSecrets(item.skill.name)
        const description = redactCommonSecrets(item.skill.description)
        const content = redactCommonSecrets(item.skill.content)
        if (displayName !== item.skill.name || description !== item.skill.description || content !== item.skill.content) {
          diagnostics.push({
            code: 'secret_redacted',
            message: '技能中疑似包含凭据,展示和模型输入已打码;原文件未修改',
            source: item.source,
            ...relativeField(root, item.skill.filePath),
          })
        }
        const logicalLocation = logicalUri(item.source, displayName)
        candidates.push({
          source: item.source,
          builtIn: isBuiltIn(role, item.source, item.skill.name),
          provenance: { kind: 'manual' },
          installationDir: dirname(item.skill.filePath),
          originalName: item.skill.name,
          skill: { ...item.skill, name: displayName, description, content, filePath: logicalLocation },
        })
      }

      const installationStore = new SkillInstallationStore(this.globalSkillsRoot())
      for (const candidate of candidates) {
        if (candidate.builtIn) {
          candidate.provenance = { kind: 'built-in' }
          continue
        }
        if (candidate.source.kind !== 'global') continue
        const sourceStatus = await installationStore.sourceRecordStatus(candidate.installationDir)
        if (sourceStatus.kind === 'valid') {
          candidate.provenance = redactProvenance(sourceStatus.record.provenance)
          if (JSON.stringify(candidate.provenance) !== JSON.stringify(sourceStatus.record.provenance)) {
            diagnostics.push({
              code: 'secret_redacted', message: '技能来源记录中疑似包含凭据,展示时已打码', source: candidate.source,
            })
          }
        } else if (sourceStatus.kind === 'invalid') {
          diagnostics.push({
            code: 'read_failed', message: '技能来源记录损坏,已按手工技能显示', source: candidate.source,
          })
        }
      }

      const withoutSameLayerDuplicates = excludeSameLayerDuplicates(candidates, diagnostics)
      const roleNames = new Set(
        withoutSameLayerDuplicates
          .filter((entry) => entry.source.kind === 'role')
          .map((entry) => entry.originalName),
      )
      const effective = withoutSameLayerDuplicates.filter(
        (entry) => entry.source.kind === 'role' || !roleNames.has(entry.originalName),
      )
      return { effective, diagnostics }
    } finally {
      await env.cleanup()
    }
  }
}

async function canonicalOrResolved(env: NodeExecutionEnv, path: string): Promise<string> {
  const canonical = await env.canonicalPath(path)
  return canonical.ok ? canonical.value : resolve(path)
}

function rootForSource(
  inputs: readonly { path: string; source: SkillScope }[],
  source: SkillScope,
): string {
  const found = inputs.find((input) => scopeKey(input.source) === scopeKey(source))
  if (!found) throw new Error('技能来源与扫描目录不一致')
  return found.path
}

function excludeSameLayerDuplicates(
  candidates: readonly EffectiveSkill[],
  diagnostics: SkillDiagnosticView[],
): EffectiveSkill[] {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    const key = `${scopeKey(candidate.source)}\0${candidate.originalName}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const duplicateKeys = new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
  for (const key of duplicateKeys) {
    const sample = candidates.find(
      (candidate) => `${scopeKey(candidate.source)}\0${candidate.originalName}` === key,
    )
    if (sample) {
      diagnostics.push({
        code: 'duplicate_name',
        message: `同一层存在多个名为「${sample.skill.name}」的技能,已全部忽略`,
        source: sample.source,
      })
    }
  }
  return candidates.filter(
    (candidate) => !duplicateKeys.has(`${scopeKey(candidate.source)}\0${candidate.originalName}`),
  )
}

function diagnosticView(
  diagnostic: SkillDiagnostic & { source: SkillScope },
  root: string,
): SkillDiagnosticView {
  return {
    code: diagnostic.code as SkillDiagnosticCode,
    message: diagnosticMessage(diagnostic.code, diagnostic.message),
    source: diagnostic.source,
    ...relativeField(root, diagnostic.path),
  }
}

function relativeField(root: string, path: string): { relativePath?: string } {
  const rel = relative(resolve(root), resolve(path))
  if (!rel || rel === '.') return {}
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) return {}
  return { relativePath: redactCommonSecrets(rel.split('\\').join('/')) }
}

function diagnosticMessage(code: SkillDiagnostic['code'], message: string): string {
  const safeOriginal = redactCommonSecrets(message)
  if (code === 'invalid_metadata') {
    let chinese = '技能元数据不合法'
    if (/description is required/i.test(message)) chinese = '缺少 description(技能说明)'
    else if (/name .+ does not match parent directory/i.test(message)) chinese = '技能名与文件夹名不一致'
    else if (/name/i.test(message)) chinese = '技能 name(技能名)格式不合法'
    return withOriginal(chinese, safeOriginal)
  }
  const generic: Record<Exclude<SkillDiagnostic['code'], 'invalid_metadata'>, string> = {
    file_info_failed: '无法读取技能文件信息',
    list_failed: '无法列出技能目录',
    read_failed: '无法读取技能 Markdown',
    parse_failed: 'SKILL.md 头部解析失败',
  }
  return withOriginal(generic[code], safeOriginal)
}

function withOriginal(chinese: string, original: string): string {
  return original ? `${chinese}（英文原文：${original}）` : chinese
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../'))
}

function logicalUri(source: SkillScope, name: string): string {
  return source.kind === 'global'
    ? `daweige-skill://global/${encodeURIComponent(name)}/SKILL.md`
    : `daweige-skill://role/${source.roleId}/${encodeURIComponent(name)}/SKILL.md`
}

function scopeKey(source: SkillScope): string {
  return source.kind === 'global' ? 'global' : `role:${source.roleId}`
}

function isBuiltIn(role: SkillRoleTarget | undefined, source: SkillScope, name: string): boolean {
  return (source.kind === 'global' && GLOBAL_BUILT_INS.has(name))
    || (source.kind === 'role' && role !== undefined && BUILT_IN_BY_TEMPLATE[role.templateId ?? ''] === name)
}

function toInstalledSkill(entry: EffectiveSkill): InstalledSkill {
  return {
    id: `${scopeKey(entry.source)}:${entry.skill.name}`,
    name: entry.skill.name,
    description: entry.skill.description,
    source: entry.source,
    builtIn: entry.builtIn,
    logicalLocation: entry.skill.filePath,
    provenance: entry.provenance,
    canUninstall: entry.source.kind === 'global'
      && (entry.provenance.kind === 'market' || entry.provenance.kind === 'authored'),
  }
}

function compareInstalled(a: InstalledSkill, b: InstalledSkill): number {
  return scopeKey(a.source).localeCompare(scopeKey(b.source)) || a.name.localeCompare(b.name)
}

function redactProvenance(provenance: SkillProvenance): SkillProvenance {
  if (provenance.kind !== 'market') return provenance
  return {
    ...provenance,
    registryName: redactCommonSecrets(provenance.registryName),
    slug: redactCommonSecrets(provenance.slug),
    ...(provenance.owner ? { owner: redactCommonSecrets(provenance.owner) } : {}),
    ...(provenance.version ? { version: redactCommonSecrets(provenance.version) } : {}),
    ...(provenance.license ? { license: redactCommonSecrets(provenance.license) } : {}),
  }
}

function dedupeDiagnostics(items: readonly SkillDiagnosticView[]): SkillDiagnosticView[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${scopeKey(item.source)}\0${item.code}\0${item.relativePath ?? ''}\0${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
