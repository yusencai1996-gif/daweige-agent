// 使用统计"有数据"截图:临时 userData 灌一年合成用量(纯假数据),截统计页
const { _electron: electron } = require('playwright')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const OUT = 'F:/xiaokong-projects/daweige-public-snapshot/docs/screenshots/usage.png'
const EXE = 'F:/xiaokong-projects/daweige-agent/release-v7/win-unpacked/大微阁.exe'

// 确定性伪随机(与项目 mock 同风格),数值形态贴近真实使用:工作日多、周末少、近期爬升
function makeEvents() {
  const events = []
  const models = [
    { provider: 'kimi-coding', modelId: 'kimi-for-coding', weight: 0.55 },
    { provider: 'zai-coding-cn', modelId: 'glm-5.3', weight: 0.3 },
    { provider: 'deepseek', modelId: 'deepseek-v4-flash', weight: 0.15 },
  ]
  let seed = 20260825
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const now = Date.now()
  for (let dayBack = 364; dayBack >= 0; dayBack--) {
    const d = new Date(now - dayBack * 86400000)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dow = d.getDay()
    const weekend = dow === 0 || dow === 6
    const recentBoost = dayBack < 30 ? 1.6 : dayBack < 90 ? 1.15 : 1
    const active = rand() > (weekend ? 0.55 : 0.3)
    if (!active) continue
    const sessions = 1 + Math.floor(rand() * 4)
    for (let s = 0; s < sessions; s++) {
      const m = models[rand() < models[0].weight ? 0 : rand() < 0.66 ? 1 : 2]
      const total = Math.round((3000 + rand() * 45000) * recentBoost)
      const input = Math.round(total * 0.45)
      const output = Math.round(total * 0.15)
      const cacheRead = total - input - output
      const hh = 9 + Math.floor(rand() * 12)
      const mm = Math.floor(rand() * 60)
      events.push({
        sourceEntryId: `demo-${iso}-${s}`,
        sessionId: `demo-session-${dayBack}-${s % 7}`,
        provider: m.provider,
        modelId: m.modelId,
        responseModelId: null,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: null,
        totalTokens: total,
        occurredAtMs: new Date(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`).getTime(),
        localDate: iso,
        timezoneId: 'Asia/Shanghai',
        stopReason: 'stop',
      })
    }
  }
  return events
}

;(async () => {
  // 纯 SQL 直写 usage.sqlite(schema 与 usage-store.ts 的 SCHEMA 一致)
  const { DatabaseSync } = require('node:sqlite')
  const userData = await mkdtemp(path.join(tmpdir(), 'dw-usage-shot-'))
  const fs = require('node:fs')
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true })
  const db = new DatabaseSync(path.join(userData, 'data', 'usage.sqlite'))
  db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
    source_entry_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
    model_id TEXT NOT NULL, response_model_id TEXT, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, cache_write_1h_tokens INTEGER,
    total_tokens INTEGER NOT NULL, occurred_at_ms INTEGER NOT NULL, local_date TEXT NOT NULL,
    timezone_id TEXT NOT NULL, stop_reason TEXT NOT NULL, source_kind TEXT NOT NULL,
    ingested_at_ms INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_usage_events_date ON usage_events(local_date);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_date ON usage_events(provider, response_model_id, model_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
    CREATE TABLE IF NOT EXISTS usage_session_spans (
      session_id TEXT PRIMARY KEY, first_message_at_ms INTEGER NOT NULL,
      last_message_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      CHECK (last_message_at_ms >= first_message_at_ms)) WITHOUT ROWID;`)
  const stmt = db.prepare(`INSERT OR IGNORE INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const span = db.prepare(`INSERT INTO usage_session_spans VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    last_message_at_ms = excluded.last_message_at_ms, updated_at_ms = excluded.updated_at_ms`)
  const events = makeEvents()
  const now = Date.now()
  const firstBySession = new Map()
  for (const e of events) {
    stmt.run(e.sourceEntryId, e.sessionId, e.provider, e.modelId, e.responseModelId,
      e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.cacheWrite1hTokens,
      e.totalTokens, e.occurredAtMs, e.localDate, e.timezoneId, e.stopReason, 'backfill', now)
    if (!firstBySession.has(e.sessionId)) firstBySession.set(e.sessionId, e.occurredAtMs)
    span.run(e.sessionId, firstBySession.get(e.sessionId), e.occurredAtMs, now)
  }
  console.log('seeded events =', events.length)
  db.close()

  const app = await electron.launch({ executablePath: EXE, env: { ...process.env, DAWEIGE_USER_DATA: userData } })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1440, height: 1120 }).catch(() => {})
  await win.waitForTimeout(3500)
  await win.getByText('使用统计', { exact: true }).click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: OUT })
  console.log('usage shot ok')
  await app.close()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
