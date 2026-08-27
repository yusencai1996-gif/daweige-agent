import type { DelegationResult } from '../../shared/domain/manager'
import type { DelegationPathViolation } from '../files/path-policy'
import { StrictDelegationPathPolicy } from '../files/path-policy'

const OPEN = '<daweige-delegation-result version="1">'
const CLOSE = '</daweige-delegation-result>'
const MAX_FINAL_TEXT = 200_000
const MAX_JSON_CHARS = 50_000
const MAX_SUMMARY_CHARS = 20_000
const MAX_ITEMS = 100
const MAX_ITEM_CHARS = 4_000
/** A-19 数据明细:与 taskBrief 同级上限;交棒时仍受 envelope 单条 2_000 截断。 */
const MAX_DETAIL_CHARS = 4_000

interface ParsedResult {
  readonly summary: string
  readonly conclusions: readonly string[]
  readonly artifactPaths: readonly string[]
  readonly unmetCriteria: readonly string[]
  readonly detailData?: string
}

export function parseDelegationResult(
  finalText: string,
  acceptanceCriteria: readonly string[],
): ParsedResult {
  if (finalText.length > MAX_FINAL_TEXT) return fallback(finalText, acceptanceCriteria)
  const firstOpen = finalText.indexOf(OPEN)
  const lastOpen = finalText.lastIndexOf(OPEN)
  const close = finalText.indexOf(CLOSE, firstOpen + OPEN.length)
  // 伪造/多块/未收尾都 fail closed;结果块必须是最后一段实质内容。
  if (
    firstOpen < 0 ||
    firstOpen !== lastOpen ||
    close < 0 ||
    finalText.indexOf(CLOSE, close + CLOSE.length) >= 0 ||
    finalText.slice(close + CLOSE.length).trim().length > 0
  ) {
    return fallback(finalText, acceptanceCriteria)
  }
  const json = finalText.slice(firstOpen + OPEN.length, close).trim()
  if (json.length === 0 || json.length > MAX_JSON_CHARS) {
    return fallback(finalText, acceptanceCriteria)
  }
  try {
    const value: unknown = JSON.parse(json)
    if (!isRecord(value)) return fallback(finalText, acceptanceCriteria)
    const keys = Object.keys(value).sort()
    const baseKeys = ['artifactPaths', 'conclusions', 'summary', 'unmetCriteria'].sort().join(',')
    // A-19:detailData 可选——四键(旧格式/未产出明细)或五键都合法,其余键仍 fail closed
    const detailPresent = keys.includes('detailData')
    const expectedKeys = detailPresent
      ? ['artifactPaths', 'conclusions', 'detailData', 'summary', 'unmetCriteria'].sort().join(',')
      : baseKeys
    if (keys.join(',') !== expectedKeys) {
      return fallback(finalText, acceptanceCriteria)
    }
    const rawDetail: unknown = detailPresent ? value.detailData : undefined
    const detail = typeof rawDetail === 'string' && rawDetail.length >= 1 && rawDetail.length <= MAX_DETAIL_CHARS
      ? rawDetail
      : undefined
    if (detailPresent && detail === undefined) {
      return fallback(finalText, acceptanceCriteria)
    }
    if (
      !validString(value.summary, 1, MAX_SUMMARY_CHARS) ||
      !validStringArray(value.conclusions) ||
      !validStringArray(value.artifactPaths) ||
      !validStringArray(value.unmetCriteria)
    ) {
      return fallback(finalText, acceptanceCriteria)
    }
    return {
      summary: value.summary,
      conclusions: value.conclusions,
      artifactPaths: value.artifactPaths,
      unmetCriteria: value.unmetCriteria,
      ...(detail !== undefined ? { detailData: detail } : {}),
    }
  } catch {
    return fallback(finalText, acceptanceCriteria)
  }
}

export async function buildDelegationResult(input: {
  readonly finalText: string
  readonly acceptanceCriteria: readonly string[]
  readonly policy: StrictDelegationPathPolicy
  readonly boundaryViolations: readonly DelegationPathViolation[]
}): Promise<DelegationResult> {
  const parsed = parseDelegationResult(input.finalText, input.acceptanceCriteria)
  const acceptedArtifacts: string[] = []
  const artifactViolations: DelegationResult['boundaryViolations'][number][] = []
  for (const artifact of parsed.artifactPaths) {
    let canonical = artifact
    try {
      const checked = await input.policy.classify(artifact)
      canonical = checked.realPath
      if (checked.zone === 'workspace') {
        acceptedArtifacts.push(canonical)
        continue
      }
    } catch {
      // 保留原始声称以便审计,不包含文件内容。
    }
    artifactViolations.push({
      path: canonical,
      operation: 'write',
      reason: '模型声称的产物路径超出本次派活允许范围,已不采信',
      occurredAt: Date.now(),
    })
  }
  return {
    summary: parsed.summary,
    conclusions: parsed.conclusions,
    artifactPaths: acceptedArtifacts,
    unmetCriteria: parsed.unmetCriteria,
    ...(parsed.detailData !== undefined ? { detailData: parsed.detailData } : {}),
    boundaryViolations: [
      ...input.boundaryViolations.map((violation) => ({
        path: violation.path,
        operation: violation.operation,
        reason: violation.reason,
        occurredAt: violation.occurredAt,
      })),
      ...artifactViolations,
    ],
  }
}

function fallback(finalText: string, acceptanceCriteria: readonly string[]): ParsedResult {
  return {
    summary: finalText.slice(0, MAX_SUMMARY_CHARS),
    conclusions: [],
    artifactPaths: [],
    unmetCriteria: [...acceptanceCriteria],
  }
}

function validString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ITEMS &&
    value.every((item) => validString(item, 1, MAX_ITEM_CHARS))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
