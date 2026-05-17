// One-shot Pulsar health snapshot. Run: npx tsx scripts/pulsar-status.ts
// Flags:
//   --url=http://...    override base URL (defaults to http://localhost:3103)
// Exits non-zero if /health is degraded, any source has consecutive failures,
// or any source's last success is past its expected staleness threshold.

type StatusBody = {
  data: {
    sources: Array<{
      sourceId: string
      lastStatus: string | null
      lastSuccessAt: string | null
      lastFailureAt: string | null
      consecutiveFailures: number
    }>
    counts: { assets: number; priceTicks: number; dailySummaries: number; macroSeries: number }
    db: { sizeBytes: number; walSizeBytes: number }
  }
}

type HealthBody = { status: string; db?: string; uptimeSeconds?: number; error?: string }

// US equity market hours (Mon–Fri 9:30–16:00 ET). Holidays not modeled —
// false alarms on a few holidays/year are acceptable for a status script.
function inUsMarketHours(d = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const weekday = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hm = hour * 60 + minute
  return hm >= 9 * 60 + 30 && hm < 16 * 60
}

// Max acceptable age of last success per source. Tied to cron in ecosystem.config.cjs;
// generous so a single missed run doesn't flag. yahoo is gated by market hours —
// outside the window, no staleness check (any age is fine).
function stalenessLimitMs(sourceId: string): number {
  switch (sourceId) {
    case 'coingecko':
    case 'mempool':
      return 15 * 60_000
    case 'yahoo':
      return inUsMarketHours() ? 30 * 60_000 : Infinity
    case 'exchangerate':
      return 90 * 60_000
    case 'fred':
      return 26 * 60 * 60_000
    default:
      return Infinity
  }
}

const KNOWN_SOURCES = ['coingecko', 'mempool', 'yahoo', 'exchangerate', 'fred']

const args = process.argv.slice(2)
const urlFlag = args.find((a) => a.startsWith('--url='))?.slice(6)
const baseUrl = urlFlag ?? 'http://localhost:3103'

async function getJson<T>(path: string): Promise<{ ok: true; status: number; body: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(baseUrl + path)
    const body = (await res.json()) as T
    return { ok: res.ok, status: res.status, body } as const
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

function fmtAge(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'in the future?'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const RED = '\x1b[31m'
const YEL = '\x1b[33m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

const [health, status] = await Promise.all([getJson<HealthBody>('/health'), getJson<StatusBody>('/api/status')])

console.log(`\n${DIM}pulsar @ ${baseUrl}  ·  ${new Date().toISOString()}${RST}\n`)

let bad = false

// ── Health ────────────────────────────────────────────────────────────────────
if (!health.ok) {
  console.log(`${RED}● API unreachable${RST}  (${'error' in health ? health.error : `HTTP ${health.status}`})`)
  bad = true
} else {
  const h = health.body
  const ok = h.status === 'ok' && h.db === 'ok'
  const dot = ok ? `${GRN}●${RST}` : `${RED}●${RST}`
  console.log(`${dot} API ${h.status}  ·  db=${h.db ?? '?'}  ·  uptime ${fmtUptime(h.uptimeSeconds ?? 0)}`)
  if (!ok) bad = true
}

// ── Sources ───────────────────────────────────────────────────────────────────
if (status.ok) {
  const rows = status.body.data.sources
  const seen = new Set(rows.map((r) => r.sourceId))
  const missing = KNOWN_SOURCES.filter((s) => !seen.has(s))

  console.log(`\n${DIM}sources${RST}`)
  const colW = { src: 14, st: 9, age: 16, fail: 6 }
  console.log(
    `  ${'source'.padEnd(colW.src)}${'status'.padEnd(colW.st)}${'last success'.padEnd(colW.age)}${'fails'.padEnd(colW.fail)}`,
  )
  for (const r of rows) {
    const limit = stalenessLimitMs(r.sourceId)
    const age = r.lastSuccessAt ? Date.now() - new Date(r.lastSuccessAt).getTime() : Infinity
    const stale = age > limit
    const failing = r.consecutiveFailures > 0
    const color = failing || stale ? RED : r.lastStatus === 'SUCCESS' ? GRN : YEL
    if (failing || stale) bad = true
    console.log(
      `  ${color}${r.sourceId.padEnd(colW.src)}${(r.lastStatus ?? '-').padEnd(colW.st)}${fmtAge(r.lastSuccessAt).padEnd(colW.age)}${String(r.consecutiveFailures).padEnd(colW.fail)}${RST}`,
    )
  }
  for (const m of missing) {
    console.log(`  ${YEL}${m.padEnd(colW.src)}${'-'.padEnd(colW.st)}${'no jobs yet'.padEnd(colW.age)}${'-'.padEnd(colW.fail)}${RST}`)
    bad = true
  }

  // ── Counts + DB ─────────────────────────────────────────────────────────────
  const c = status.body.data.counts
  const db = status.body.data.db
  console.log(
    `\n${DIM}rows${RST}    assets=${c.assets}  ticks=${c.priceTicks}  daily=${c.dailySummaries}  macro=${c.macroSeries}`,
  )
  console.log(`${DIM}db${RST}      ${fmtBytes(db.sizeBytes)} (+${fmtBytes(db.walSizeBytes)} WAL)`)
} else {
  console.log(`\n${RED}/status unreachable${RST}  (${'error' in status ? status.error : `HTTP ${status.status}`})`)
  bad = true
}

console.log()
process.exit(bad ? 1 : 0)
