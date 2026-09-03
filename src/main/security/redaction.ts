/**
 * 日志脱敏(M2-03)。
 * 铁律:key 明文绝不进日志;所有可能包含用户输入/异常信息的日志输出前先过 redactSecrets。
 */

const MASK = '***'

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of secrets) {
    // 短串(如 "abc")误替换风险高,只脱敏有意义的长度
    if (secret.length >= 8) {
      out = out.split(secret).join(MASK)
    }
  }
  return out
}

/** 打码展示:保留头 3 尾 4,中间全掩;短 key 全掩。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}

/**
 * 通用形态脱敏(复审 S-02):不需要知道具体 key,
 * 直接把常见 key 形态(sk-xxx / api-key 长串等)打码。日志出口统一过这个。
 */
export function redactCommonSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, (m) => `${m.slice(0, 5)}***`)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKI***')
    .replace(/(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, '$1***')
    .replace(
      /(\b(?:api[_-]?key|token|authorization|password|secret|kimi[_-]?key|glm[_-]?key|zai[_-]?key|deepseek[_-]?key)\b\s*[:=]\s*["']?(?:bearer\s+)?)([A-Za-z0-9._~+/=-]{8,})/gi,
      '$1***',
    )
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '***.***')
}
