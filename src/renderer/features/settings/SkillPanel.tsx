import { useCallback, useEffect, useRef, useState } from 'react'
import type { DaweigeBridge } from '../../../shared/ipc/bridge'
import type { InstalledSkill, RoleSummary, SkillListSnapshot, SkillScope } from '../../../shared/domain'

interface SkillPanelProps {
  readonly bridge: DaweigeBridge
}

interface SkillGroup {
  /** 组键:global 或 role:<roleId>。 */
  readonly key: string
  /** 组头名:全局技能 / 角色名。 */
  readonly title: string
  /** 角色组的 roleId(打开该角色技能文件夹用);全局组为 null。 */
  readonly roleId: string | null
  readonly skills: readonly InstalledSkill[]
}

/**
 * 分组:全局一组在前(有全局技能才出);角色组以 role:list 为准——
 * 没有技能的角色也出组头(角色名+「打开该角色技能文件夹」),组内空态一行,
 * 保证每个在册角色都有装第一条技能的产品入口。
 * roles 为 null(role:list 拉取失败)时退化为旧行为:只按技能来源分组。
 * 已归档角色不进分组(与主列表隐藏口径一致)。
 */
function buildGroups(skills: readonly InstalledSkill[], roles: readonly RoleSummary[] | null): SkillGroup[] {
  const globalSkills: InstalledSkill[] = []
  const skillsByRole = new Map<string, InstalledSkill[]>()
  for (const skill of skills) {
    if (skill.source.kind === 'global') {
      globalSkills.push(skill)
      continue
    }
    const { roleId } = skill.source
    const list = skillsByRole.get(roleId)
    if (list === undefined) {
      skillsByRole.set(roleId, [skill])
    } else {
      list.push(skill)
    }
  }
  const groups: SkillGroup[] = []
  if (globalSkills.length > 0) {
    groups.push({ key: 'global', title: '全局技能', roleId: null, skills: globalSkills })
  }
  if (roles !== null) {
    for (const role of roles) {
      if (role.archivedAt !== null) continue
      groups.push({
        key: `role:${role.id}`,
        title: role.displayName,
        roleId: role.id,
        skills: skillsByRole.get(role.id) ?? [],
      })
      skillsByRole.delete(role.id)
    }
  }
  // roles 拉取失败时的全量兜底 + 防御:技能来源里的角色不在 role:list(理论上不会),按旧逻辑补在末尾
  for (const [roleId, list] of skillsByRole) {
    const first = list[0]
    const title = first !== undefined && first.source.kind === 'role' ? first.source.roleDisplayName : roleId
    groups.push({ key: `role:${roleId}`, title, roleId, skills: list })
  }
  return groups
}

function scopeLabel(source: SkillScope): string {
  return source.kind === 'global' ? '全局' : source.roleDisplayName
}

/** 来源徽标(0.7.0 A3):内置/自创/市场来源名/自装。 */
export function provenanceBadgeLabel(skill: InstalledSkill): string {
  switch (skill.provenance.kind) {
    case 'built-in':
      return '内置'
    case 'authored':
      return '自创'
    case 'market':
      return skill.provenance.registryName
    case 'manual':
      return '自装'
  }
}

/** 市场技能的版本/许可/作者摘要行;字段缺失就省略,全缺返回空串不渲染。 */
function provenanceMetaLine(skill: InstalledSkill): string {
  if (skill.provenance.kind !== 'market') return ''
  const provenance = skill.provenance
  const parts: string[] = []
  if (provenance.owner !== undefined && provenance.owner !== '') parts.push(`作者 ${provenance.owner}`)
  if (provenance.version !== undefined && provenance.version !== '') parts.push(`版本 ${provenance.version}`)
  if (provenance.license !== undefined && provenance.license !== '') parts.push(`许可 ${provenance.license}`)
  parts.push(`装于 ${new Date(provenance.installedAt).toLocaleDateString('zh-CN')}`)
  return parts.join(' · ')
}

interface SkillRowProps {
  readonly skill: InstalledSkill
  /** 卸载请求要带的 generation(skill:uninstall 契约),取父级当前 snapshot。 */
  readonly generation: number
  readonly bridge: DaweigeBridge
  /** 卸载成功后用返回的新 snapshot 刷新列表。 */
  readonly onUninstalled: (snapshot: SkillListSnapshot) => void
}

/**
 * 技能行(0.7.0 A3):名称 + 来源徽标 + 描述 + 市场元信息;
 * market/authored 且 canUninstall 才给卸载——行内二次确认(不是单击即删),
 * Escape 可收起,焦点在「卸载」与「先留着」之间来回归还。
 */
export function SkillRow({ skill, generation, bridge, onUninstalled }: SkillRowProps) {
  const [confirming, setConfirming] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const uninstallButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  /** 只有真正展开过确认区,收起时才把焦点还给「卸载」(首次渲染不抢焦点)。 */
  const wasConfirmingRef = useRef(false)

  const canUninstall =
    skill.canUninstall &&
    (skill.provenance.kind === 'market' || skill.provenance.kind === 'authored')
  const metaLine = provenanceMetaLine(skill)

  useEffect(() => {
    if (confirming) {
      wasConfirmingRef.current = true
      // 初始焦点放「先留着」(与清空弹层同一安全惯例),不把焦点送上破坏性按钮
      cancelButtonRef.current?.focus()
    } else if (wasConfirmingRef.current) {
      wasConfirmingRef.current = false
      uninstallButtonRef.current?.focus()
    }
  }, [confirming])

  const confirmUninstall = async () => {
    if (uninstalling) return
    setUninstalling(true)
    setError(null)
    try {
      const next = await bridge.invoke('skill:uninstall', {
        skillId: skill.id,
        expectedGeneration: generation,
      })
      onUninstalled(next)
    } catch (uninstallError) {
      setError(
        uninstallError instanceof Error ? uninstallError.message : String(uninstallError),
      )
      setUninstalling(false)
    }
  }

  return (
    <div className="skill-item">
      <div className="skill-item-main">
        <div className="skill-item-head">
          <span className="skill-item-name">{skill.name}</span>
          <span className="skill-item-badge">{provenanceBadgeLabel(skill)}</span>
          {canUninstall && !confirming && (
            <span className="skill-item-head-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                ref={uninstallButtonRef}
                onClick={() => {
                  setError(null)
                  setConfirming(true)
                }}
              >
                卸载
              </button>
            </span>
          )}
        </div>
        <div className="skill-item-desc">{skill.description}</div>
        {metaLine !== '' && <div className="skill-item-meta">{metaLine}</div>}
        {canUninstall && confirming && (
          <div
            className="skill-uninstall-confirm"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !uninstalling) setConfirming(false)
            }}
          >
            <span>
              确认卸载「{skill.name}」?删进回收站,后悔了能捞回来;卸载后新建对话生效。
            </span>
            <div className="skill-uninstall-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={uninstalling}
                onClick={() => void confirmUninstall()}
              >
                {uninstalling ? '正在卸载…' : '确认卸载'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                ref={cancelButtonRef}
                disabled={uninstalling}
                onClick={() => setConfirming(false)}
              >
                先留着
              </button>
            </div>
            {error !== null && (
              <div className="skill-uninstall-error" role="alert">
                没卸成:{error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 设置页「技能」(0.6.0 F1;0.7.0 A3 增来源徽标与卸载):列出已安装技能,按来源分组;
 * 角色分组以 role:list 为准——没有技能的角色也显示组头与「打开该角色技能文件夹」,
 * 让每个在册角色都有装第一条技能的入口;
 * 打开文件夹/刷新两个动作;诊断用克制的警示列表(只显示人话 message,不出绝对路径);
 * 卸载只对 market/authored 且 canUninstall 的全局技能开放,行内二次确认,不走任何路径。
 * 不做编辑/安装市场浏览/脚本状态。
 */
export function SkillPanel({ bridge }: SkillPanelProps) {
  const [snapshot, setSnapshot] = useState<SkillListSnapshot | null>(null)
  /** 在册角色(role:list);null=还没拉到或拉取失败(分组退化为按技能来源)。 */
  const [roles, setRoles] = useState<readonly RoleSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** 打开文件夹在途的组键('global' 或 roleId),防重复点击。 */
  const [openingFolder, setOpeningFolder] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** 角色清单独立拉取:失败不拖垮技能列表,只让空角色组入口缺席。 */
  const loadRoles = useCallback(async () => {
    try {
      return await bridge.invoke('role:list', undefined)
    } catch {
      return null
    }
  }, [bridge])

  const load = useCallback(async () => {
    setLoadError(null)
    setNotice(null)
    const [rolesResult, skillResult] = await Promise.allSettled([
      loadRoles(),
      bridge.invoke('skill:list', undefined),
    ])
    if (rolesResult.status === 'fulfilled') setRoles(rolesResult.value)
    if (skillResult.status === 'fulfilled') {
      setSnapshot(skillResult.value)
    } else {
      setLoadError(
        skillResult.reason instanceof Error ? skillResult.reason.message : String(skillResult.reason),
      )
    }
  }, [bridge, loadRoles])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setNotice(null)
    try {
      const [result, freshRoles] = await Promise.all([
        bridge.invoke('skill:refresh', undefined),
        loadRoles(),
      ])
      setSnapshot(result)
      setRoles(freshRoles)
      setLoadError(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }

  const openFolder = async (key: string, roleId: string | null) => {
    if (openingFolder !== null) return
    setOpeningFolder(key)
    setNotice(null)
    try {
      await bridge.invoke(
        'skill:openFolder',
        roleId === null ? { scope: 'global' } : { scope: 'role', roleId },
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setOpeningFolder(null)
    }
  }

  const groups = snapshot === null ? [] : buildGroups(snapshot.skills, roles)
  const diagnostics = snapshot?.diagnostics ?? []

  return (
    <div className="skill-panel">
      <div className="skill-toolbar">
        <span className="skill-toolbar-desc">刷新后,新建会话生效。</span>
        <div className="skill-toolbar-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={openingFolder !== null}
            onClick={() => void openFolder('global', null)}
          >
            {openingFolder === 'global' ? '正在打开…' : '打开全局技能文件夹'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? '正在刷新…' : '刷新'}
          </button>
        </div>
      </div>

      {loadError !== null ? (
        <div className="memory-state" role="alert">
          没拉出来:{loadError}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            再试一次
          </button>
        </div>
      ) : snapshot === null ? (
        <div className="memory-state">正在扫技能文件夹…</div>
      ) : (
        <>
          {groups.length === 0 ? (
            <div className="memory-state">
              还没装任何技能。点「打开全局技能文件夹」放进技能,回来点「刷新」就会出现在这里。
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="skill-group">
                <div className="skill-group-head">
                  <span className="skill-group-title">{group.title}</span>
                  {group.roleId !== null && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={openingFolder !== null}
                      onClick={() => void openFolder(group.key, group.roleId)}
                    >
                      {openingFolder === group.key ? '正在打开…' : '打开该角色技能文件夹'}
                    </button>
                  )}
                </div>
                <div className="skill-list">
                  {group.skills.length === 0 ? (
                    <div className="skill-group-empty">
                      暂无技能——点「打开该角色技能文件夹」,把技能放进去再刷新即可。
                    </div>
                  ) : (
                    group.skills.map((skill) => (
                      <SkillRow
                        key={skill.id}
                        skill={skill}
                        generation={snapshot.generation}
                        bridge={bridge}
                        onUninstalled={setSnapshot}
                      />
                    ))
                  )}
                </div>
              </section>
            ))
          )}

          {diagnostics.length > 0 && (
            <div className="skill-diagnostics" role="status">
              <div className="skill-diagnostics-title">
                有 {diagnostics.length} 个技能没读出来
              </div>
              <ul className="skill-diagnostics-list">
                {diagnostics.map((item, index) => (
                  <li key={`${item.code}-${index}`}>
                    <span className="skill-diagnostics-scope">{scopeLabel(item.source)}</span>
                    {item.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {notice !== null && (
        <div className="memory-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
