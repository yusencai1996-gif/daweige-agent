import type { MemoryDate } from '../../shared/domain/memory'

/** 统一校验所有进入持久层的记忆日期，避免 Date 自动进位接受不存在的日期。 */
export function assertValidMemoryDate(value: unknown): asserts value is MemoryDate {
  if (!value || typeof value !== 'object') throw new Error('记忆日期格式不合法')
  const date = value as Record<string, unknown>
  if (date['kind'] === 'fixed' && typeof date['iso'] === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date['iso'])
    if (match && isUtcDate(Number(match[1]), Number(match[2]), Number(match[3]))) return
  }
  if (
    date['kind'] === 'recurring'
    && Number.isInteger(date['month'])
    && Number.isInteger(date['day'])
    && isUtcDate(2000, date['month'] as number, date['day'] as number)
  ) return
  throw new Error('记忆日期不存在，请填写有效的年月日')
}

export function isValidMemoryDate(value: unknown): value is MemoryDate {
  try { assertValidMemoryDate(value); return true } catch { return false }
}

function isUtcDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
