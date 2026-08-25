import mammoth from 'mammoth'

/** Word 读取适配器(M4-05):mammoth 提取纯文本;绝不把转换 HTML 注入 UI。 */

export async function extractDocxText(buf: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer: buf })
  // HTML 只在这里内部使用:剥成纯文本(换行/列表结构保留为文本行)
  return htmlToText(html)
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/p>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/li>/g, '\n')
    .replace(/<li>/g, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
