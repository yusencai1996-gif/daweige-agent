import type { Reminder } from '../../../shared/domain'

interface ReminderBannerProps {
  readonly reminder: Reminder
  readonly onDismiss: (memoryId: string) => void
}

function whenText(daysUntil: number): string {
  if (daysUntil <= 0) return '就是今天'
  if (daysUntil === 1) return '明天就到了'
  if (daysUntil === 2) return '后天就到了'
  return `还有 ${daysUntil} 天`
}

function cnDate(iso: string): string {
  const parts = iso.split('-')
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!Number.isFinite(month) || !Number.isFinite(day)) return iso
  return `${month} 月 ${day} 日`
}

/** 启动提醒 banner,如「妈妈生日还有 3 天(8 月 25 日)」。 */
export function ReminderBanner({ reminder, onDismiss }: ReminderBannerProps) {
  return (
    <div className="reminder-banner" role="status">
      <span className="reminder-dot" aria-hidden="true" />
      <span className="reminder-text">
        {reminder.title}
        {whenText(reminder.daysUntil)}
        <span className="reminder-date">({cnDate(reminder.date)})</span>
      </span>
      <button
        type="button"
        className="reminder-dismiss"
        onClick={() => onDismiss(reminder.memoryId)}
      >
        知道了
      </button>
    </div>
  )
}
