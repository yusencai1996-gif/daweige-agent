import type { MemoryEntry, Reminder } from '../../shared/domain/memory'

/**
 * 纪念日提醒(M5-03):未来 N 天(默认 7 天)按本地时区计算。
 * 跨年:recurring 记忆在当年/次年各算一次,取落在窗口内的那次。
 * 闰日(2/29)在平年按 2/28 提示(提前一天,不漏提醒)。
 */

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export class ReminderService {
  constructor(
    private readonly records: () => Promise<readonly MemoryEntry[]>,
    private readonly clock: Clock = systemClock,
  ) {}

  /** 未来 daysWithin 天内的提醒(含今天,daysUntil=0)。 */
  async listUpcoming(daysWithin = 7): Promise<Reminder[]> {
    const today = startOfDay(this.clock.now())
    const records = await this.records()
    const out: Reminder[] = []
    for (const record of records) {
      const hit = this.nextOccurrence(record, today, daysWithin)
      if (hit) {
        out.push({
          memoryId: record.id,
          title: record.title,
          date: iso(hit),
          daysUntil: diffDays(today, hit),
        })
      }
    }
    return out.sort((a, b) => a.daysUntil - b.daysUntil)
  }

  private nextOccurrence(
    record: MemoryEntry,
    today: Date,
    daysWithin: number,
  ): Date | undefined {
    const candidates: Date[] = []
    if (record.date?.kind === 'recurring') {
      const { month, day } = record.date
      for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
        candidates.push(resolveMonthDay(year, month, day))
      }
    } else if (record.date?.kind === 'fixed') {
      const d = parseIso(record.date.iso)
      if (d) candidates.push(d)
    } else {
      return undefined
    }
    return candidates
      .filter((d) => d >= today)
      .find((d) => diffDays(today, d) <= daysWithin)
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function resolveMonthDay(year: number, month: number, day: number): Date {
  if (month === 2 && day === 29 && !isLeap(year)) {
    // 平年闰日生日:按 2/28 提前提示
    return new Date(year, 1, 28)
  }
  return new Date(year, month - 1, day)
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

function iso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function parseIso(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2])! - 1, Number(m[3]))
}
