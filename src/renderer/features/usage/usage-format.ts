/**
 * 使用统计数字格式化(纯函数,无依赖,可单测)。
 * 口径:token 用中文单位万/亿缩写;tooltip/明细用完整整数;时长用小时/分钟;百分比按量级取一或两位小数。
 */

/** 完整整数千分位(tooltip、明细列表 title 用,永不缩写)。 */
export function formatTokensFull(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN')
}

/** token 中文单位缩写:>=1亿→亿(两位),>=1万→万(一位),其余千分位整数。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e8) return `${trimZeros((value / 1e8).toFixed(2))}亿`
  if (value >= 1e4) return `${trimZeros((value / 1e4).toFixed(1))}万`
  return formatTokensFull(value)
}

/** 去掉小数尾零:"1.20"→"1.2","2.00"→"2"。 */
function trimZeros(text: string): string {
  return text.replace(/\.?0+$/, '')
}

/** 时长:>=1小时→"2小时35分"(整点省分);<1小时→"35分钟";0→"0分钟"。 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0分钟'
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 1) return '1分钟内'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}分钟`
  return minutes === 0 ? `${hours}小时` : `${hours}小时${minutes}分`
}

/** 占比:ratio∈[0,1];>=10% 取一位小数,其余两位;0→"0%"。 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const pct = ratio * 100
  const text = pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)
  return `${trimZeros(text)}%`
}

/**
 * 把格式化后的短文本切成「数字+单位」组合段:"2小时36分"→["2小时","36分"]、
 * "20.1万"→["20.1万"]、"3 天"→["3 天"](内部空格并入组合)。
 * 卡片值逐段包 nowrap:折行只允许发生在组合之间,单位字不掉队孤行(0.5.0 视觉验收);
 * 值文本本身不变(拼接回原串),title/复制不受影响。
 */
export function numberUnitSegments(text: string): readonly string[] {
  const re = /\d[\d,]*(?:\.\d+)?\s*(?:万亿|亿|万|小时内|小时|分钟内|分钟|分|秒|天|%)?/g
  const segments: string[] = []
  let last = 0
  for (const match of text.matchAll(re)) {
    if (match.index > last) segments.push(text.slice(last, match.index))
    segments.push(match[0])
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push(text.slice(last))
  return segments
}
