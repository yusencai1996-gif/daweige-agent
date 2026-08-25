/**
 * 流式 Markdown 的「稳定前缀 + 不稳定后缀」切分。
 *
 * 规则:
 * - 以空行为顶层块边界;只有不在未闭合代码围栏内的边界才可提交。
 * - 切分边界只前进不回退(由调用方传入已提交边界 committed)。
 * - 已提交的块拆成独立字符串,交给逐个 memo 的渲染组件,之后不再重解析。
 */

/** 探测内容是否含 Markdown 语法;纯文本走跳过解析的快路径。 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)[ \t]{0,3}(#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|>[ \t]?|```|~~~)|\*\*[^*\n]+|\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]+|(^|\n)[ \t]*\|[^\n]*\|/.test(
    text,
  )
}

/** 代码围栏(``` 或 ~~~)是否成对闭合。 */
function fencesBalanced(text: string): boolean {
  const fences = text.match(/^[ \t]{0,3}(```+|~~~+)/gm)
  return fences === null || fences.length % 2 === 0
}

/**
 * 在 text 中找可提交的最远稳定边界(空行之后),不小于 committed。
 * 边界不能落在未闭合围栏内,也不能是全文末尾(末尾留给不稳定后缀)。
 */
export function findCommitBoundary(text: string, committed: number): number {
  let best = committed
  const blankLine = /\n[ \t]*\n+/g
  for (const match of text.matchAll(blankLine)) {
    const end = (match.index ?? 0) + match[0].length
    if (end <= committed) continue
    if (end >= text.length) break
    if (!fencesBalanced(text.slice(0, end))) break
    best = end
  }
  return best
}

/** 把新提交的区域按空行拆成顶层块。 */
export function splitBlocks(region: string): string[] {
  return region
    .split(/\n[ \t]*\n+/)
    .map((block) => block.replace(/[ \t\n]+$/g, ''))
    .filter((block) => block.length > 0)
}

/** 链接安全:只允许 http/https/mailto 与相对/锚点链接,其余(如 javascript:)剥掉。 */
export function safeUrlTransform(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^(\/|#|\.\/|\.\.\/)/.test(trimmed)) return trimmed
  return ''
}
