/**
 * 生活记事(记忆)领域模型。
 * 数据只存本地(userData/data/memories.json),不外发。
 */

/**
 * 记忆关联的日期。
 * - recurring: 每年重复(生日、纪念日),按月+日触发提醒;month 1-12,day 1-31。
 * - fixed: 一次性日期,ISO 格式 YYYY-MM-DD。
 */
export type MemoryDate =
  | { readonly kind: 'recurring'; readonly month: number; readonly day: number }
  | { readonly kind: 'fixed'; readonly iso: string }

export interface MemoryEntry {
  readonly id: string
  /** 原文,如"我妈生日是三月五号"。 */
  readonly text: string
  /** 提炼出的短标题,提醒展示用,如"妈妈生日"。 */
  readonly title: string
  /** 类别:生日 / 纪念日 / 偏好 / 事实 等。 */
  readonly category: string
  /** 无日期的纯事实记忆可以没有日期。 */
  readonly date?: MemoryDate
  readonly createdAt: number
}

/** 启动时算好的提醒(未来 7 天内)。 */
export interface Reminder {
  readonly memoryId: string
  readonly title: string
  /** 提醒触发日,ISO 格式 YYYY-MM-DD。 */
  readonly date: string
  /** 距今天数:0=今天,3=3 天后。 */
  readonly daysUntil: number
}
