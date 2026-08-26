/**
 * 守则草稿块解析器(0.3.0 批 2b,PLAN §10.5)。
 *
 * 小柊消息里版本化 fenced block ` ```daweige-role-draft ` 的内容是一段 JSON:
 *   { "displayName": "建议名", "guardrails": "守则正文", "targetRoleId": "可选" }
 *
 * 铁律:坏标记(信息串不对/JSON 坏/schema 超界)只当普通 markdown 文本,
 * 原样留在正文里,不执行任何动作;AI 绝不直接落守则文件。
 */

/** 一份通过校验的守则草稿。 */
export interface RoleDraft {
  /** 建议角色名(1~24 字,与新建向导同口径)。 */
  readonly displayName: string
  /** 守则正文(1~6000 码点,与守则编辑上限同口径)。 */
  readonly guardrails: string
  /** 已存在的目标角色;null = 新角色场景。 */
  readonly targetRoleId: string | null
}

export interface RoleDraftExtraction {
  /** 去掉有效草稿块后的正文(坏块原样保留,按普通 markdown 渲染)。 */
  readonly text: string
  readonly drafts: readonly RoleDraft[]
}

const DRAFT_NAME_MAX = 24
const DRAFT_GUARDRAILS_MAX = 6000

/**  fenced code block:信息串 + 正文 + 闭合栅栏;未闭合(流式半截)不匹配,整块留作文本。 */
const FENCE_PATTERN = /```([^\n`]*)\r?\n([\s\S]*?)\r?\n```/g

/** 版本化标记:```daweige-role-draft 或 ```daweige-role-draft@v1;其余版本一律当普通文本。 */
const DRAFT_INFO_PATTERN = /^daweige-role-draft(?:@(v1))?$/

/** 码点计数(与后端 checkGuardrails 同口径,emoji 不多算)。 */
function codePointLength(text: string): number {
  return [...text].length
}

/** 把未知 JSON 收成 RoleDraft;任何字段超界返回 null(调用方原样留文本)。 */
function parseDraftJson(raw: string): RoleDraft | null {
  let value: unknown
  try {
    value = JSON.parse(raw.trim())
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const displayName = record['displayName']
  const guardrails = record['guardrails']
  const targetRoleId = record['targetRoleId']
  if (typeof displayName !== 'string') return null
  if (typeof guardrails !== 'string') return null
  const name = displayName.trim()
  const body = guardrails.trim()
  if (name.length < 1 || name.length > DRAFT_NAME_MAX) return null
  if (codePointLength(body) < 1 || codePointLength(body) > DRAFT_GUARDRAILS_MAX) return null
  if (targetRoleId !== undefined && targetRoleId !== null) {
    if (typeof targetRoleId !== 'string' || targetRoleId.trim() === '') return null
    return { displayName: name, guardrails: body, targetRoleId: targetRoleId.trim() }
  }
  return { displayName: name, guardrails: body, targetRoleId: null }
}

/**
 * 从消息正文提取全部有效草稿块。
 * 返回的正文把有效块整段剔除(草稿由卡片呈现);坏块一个字符都不动。
 */
export function extractRoleDrafts(text: string): RoleDraftExtraction {
  const drafts: RoleDraft[] = []
  // 记录有效块区间,最后一次性剔除(坏块原位保留)
  const spans: Array<readonly [number, number]> = []
  for (const match of text.matchAll(FENCE_PATTERN)) {
    const info = (match[1] ?? '').trim()
    if (!DRAFT_INFO_PATTERN.test(info)) continue
    const draft = parseDraftJson(match[2] ?? '')
    if (draft === null) continue
    drafts.push(draft)
    spans.push([match.index, match.index + match[0].length])
  }
  if (spans.length === 0) return { text, drafts: [] }
  let cleaned = ''
  let cursor = 0
  for (const [start, end] of spans) {
    cleaned += text.slice(cursor, start)
    cursor = end
  }
  cleaned += text.slice(cursor)
  // 剔除块后收尾:去掉因挖洞留下的 3 个以上连续换行,正文排版不塌
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), drafts }
}
