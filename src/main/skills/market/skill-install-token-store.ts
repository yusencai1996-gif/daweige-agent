import { randomBytes } from 'node:crypto'
import type { SkillMarketCandidate } from '../../../shared/domain/skill'

const TOKEN_TTL_MS = 10 * 60_000

export interface SkillInstallClaim {
  readonly token: string
  readonly sessionId: string
  readonly candidate: SkillMarketCandidate
  readonly fetchSlug: string
  readonly expiresAt: number
}

export class SkillInstallTokenStore {
  private readonly available = new Map<string, SkillInstallClaim>()
  private readonly active = new WeakSet<object>()

  constructor(private readonly createToken: () => string = () => `inst_${randomBytes(18).toString('base64url')}`) {}

  issue(sessionId: string, candidate: SkillMarketCandidate, fetchSlug = candidate.slug, now = Date.now()): string {
    this.prune(now)
    const token = this.createToken()
    this.available.set(token, { token, sessionId, candidate: { ...candidate }, fetchSlug, expiresAt: now + TOKEN_TTL_MS })
    return token
  }

  consume(token: string, sessionId: string, now = Date.now()): SkillInstallClaim {
    this.prune(now)
    const claim = this.available.get(token)
    if (!claim || claim.expiresAt <= now) throw new Error('安装凭证已失效，请重新搜索并选择技能。')
    if (claim.sessionId !== sessionId) throw new Error('安装凭证不属于当前会话，请重新搜索。')
    this.available.delete(token)
    this.active.add(claim)
    return claim
  }

  assertActive(claim: SkillInstallClaim, sessionId: string, now = Date.now()): void {
    if (!this.active.has(claim) || claim.sessionId !== sessionId || claim.expiresAt <= now) {
      throw new Error('安装凭证已失效，本次没有安装；请重新搜索。')
    }
  }

  finish(claim: SkillInstallClaim): void {
    this.active.delete(claim)
  }

  private prune(now: number): void {
    for (const [token, claim] of this.available) if (claim.expiresAt <= now) this.available.delete(token)
  }
}

export { TOKEN_TTL_MS }
