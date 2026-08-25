/**
 * 守则字数统计口径(S-03):Unicode 码点,与后端 checkGuardrails(src/main/roles/role-files.ts)
 * 的 [...s].length 一致。
 * 不能用 string.length(UTF-16 码元):emoji 等辅助平面字符一个占两码元,
 * UI 计数会被多数一倍,和后端「6000 字」拒绝阈值对不上。
 */
export function countCodePoints(text: string): number {
  return [...text].length
}
