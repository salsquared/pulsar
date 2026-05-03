import { Hono } from 'hono'
import prismaPromise from '../lib/prisma.js'
import { withCache } from '../lib/cache.js'
import { apiError } from '../lib/errors.js'
import { backfill } from '../ingest/pipeline.js'
import type { OhlcvPoint } from '../types.js'

const history = new Hono()

type Interval = '1h' | '1d' | '1w'

// ─── 1h — aggregate PriceTick rows via window functions ───────────────────────

async function queryHourly(
  assetId: string,
  source: string,
  from: Date,
  to: Date,
): Promise<OhlcvPoint[]> {
  const prisma = await prismaPromise

  // Prisma stores DateTime as INTEGER (unix ms). Convert via datetime() for strftime().
  // Window functions (FIRST_VALUE/LAST_VALUE) available from SQLite 3.25+.
  const rows = await prisma.$queryRaw<
    Array<{ bucket: string; o: number; h: number; l: number; c: number; v: number | null }>
  >`
    WITH ranked AS (
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', "timestamp" / 1000, 'unixepoch') AS bucket,
        close,
        COALESCE(high, close)   AS hi,
        COALESCE(low,  close)   AS lo,
        volume,
        ROW_NUMBER() OVER (
          PARTITION BY strftime('%Y-%m-%dT%H:00:00Z', "timestamp" / 1000, 'unixepoch')
          ORDER BY "timestamp" ASC
        ) AS rn_asc,
        ROW_NUMBER() OVER (
          PARTITION BY strftime('%Y-%m-%dT%H:00:00Z', "timestamp" / 1000, 'unixepoch')
          ORDER BY "timestamp" DESC
        ) AS rn_desc
      FROM "PriceTick"
      WHERE "assetId" = ${assetId}
        AND "source"  = ${source}
        AND "timestamp" BETWEEN ${from.getTime()} AND ${to.getTime()}
    )
    SELECT
      bucket,
      MAX(CASE WHEN rn_asc  = 1 THEN close END) AS o,
      MAX(hi)                                    AS h,
      MIN(lo)                                    AS l,
      MAX(CASE WHEN rn_desc = 1 THEN close END)  AS c,
      SUM(volume)                                AS v
    FROM ranked
    GROUP BY bucket
    ORDER BY bucket ASC
  `

  return rows.map((r) => ({
    t: r.bucket,
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
    v: r.v ?? null,
  }))
}

// ─── 1d — DailySummary fast path, falls back to PriceTick aggregation ────────

async function queryDaily(
  assetId: string,
  from: Date,
  to: Date,
  source?: string,
): Promise<OhlcvPoint[]> {
  const prisma = await prismaPromise

  const summaryRows = await prisma.dailySummary.findMany({
    where: { assetId, date: { gte: from, lte: to } },
    orderBy: { date: 'asc' },
  })

  if (summaryRows.length > 0) {
    return summaryRows.map((r) => ({
      t: r.date.toISOString(),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume ?? null,
    }))
  }

  // Fallback: DailySummary is empty (rollup hasn't run yet). Aggregate from
  // PriceTick by day so the endpoint is useful before Phase 10 rollup lands.
  if (!source) return []

  const rows = await prisma.$queryRaw<
    Array<{ bucket: string; o: number; h: number; l: number; c: number; v: number | null }>
  >`
    WITH ranked AS (
      SELECT
        strftime('%Y-%m-%dT00:00:00Z', "timestamp" / 1000, 'unixepoch') AS bucket,
        close,
        COALESCE(high, close) AS hi,
        COALESCE(low,  close) AS lo,
        volume,
        ROW_NUMBER() OVER (PARTITION BY strftime('%Y-%m-%d', "timestamp" / 1000, 'unixepoch') ORDER BY "timestamp" ASC)  AS rn_asc,
        ROW_NUMBER() OVER (PARTITION BY strftime('%Y-%m-%d', "timestamp" / 1000, 'unixepoch') ORDER BY "timestamp" DESC) AS rn_desc
      FROM "PriceTick"
      WHERE "assetId" = ${assetId}
        AND "source"  = ${source}
        AND "timestamp" BETWEEN ${from.getTime()} AND ${to.getTime()}
    )
    SELECT
      bucket,
      MAX(CASE WHEN rn_asc  = 1 THEN close END) AS o,
      MAX(hi)                                    AS h,
      MIN(lo)                                    AS l,
      MAX(CASE WHEN rn_desc = 1 THEN close END)  AS c,
      SUM(volume)                                AS v
    FROM ranked
    GROUP BY bucket
    ORDER BY bucket ASC
  `

  return rows.map((r) => ({ t: r.bucket, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v ?? null }))
}

// ─── 1w — aggregate DailySummary rows by ISO week (Monday-start UTC) ─────────

function isoWeekStart(date: Date): string {
  const d = new Date(date)
  const day = d.getUTCDay() // 0=Sun, 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day   // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

async function queryWeekly(assetId: string, from: Date, to: Date, source?: string): Promise<OhlcvPoint[]> {
  const dailyRows = await queryDaily(assetId, from, to, source)

  const buckets = new Map<
    string,
    { o: number; h: number; l: number; c: number; v: number | null; firstT: string; lastT: string }
  >()

  for (const row of dailyRows) {
    const week = isoWeekStart(new Date(row.t))
    const existing = buckets.get(week)
    if (!existing) {
      buckets.set(week, { o: row.o, h: row.h, l: row.l, c: row.c, v: row.v, firstT: row.t, lastT: row.t })
    } else {
      existing.h = Math.max(existing.h, row.h)
      existing.l = Math.min(existing.l, row.l)
      existing.c = row.c            // last day in week is the close
      existing.v = existing.v !== null || row.v !== null
        ? (existing.v ?? 0) + (row.v ?? 0)
        : null
      existing.lastT = row.t
    }
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, d]) => ({ t: week, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v }))
}

// ─── Route handlers ───────────────────────────────────────────────────────────

history.get('/:id', async (c) => {
  const prisma = await prismaPromise
  const id = c.req.param('id')
  const fromStr = c.req.query('from')
  const toStr = c.req.query('to')
  const intervalParam = (c.req.query('interval') ?? '1d') as Interval
  const sourceOverride = c.req.query('source')

  if (!fromStr) return apiError(c, 400, 'bad_request', '`from` query param is required (ISO date)')
  if (!['1h', '1d', '1w'].includes(intervalParam)) {
    return apiError(c, 400, 'bad_request', '`interval` must be 1h, 1d, or 1w')
  }

  const from = new Date(fromStr)
  const to = toStr ? new Date(toStr) : new Date()
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return apiError(c, 400, 'bad_request', 'Invalid date format — use ISO 8601 (e.g. 2024-01-01)')
  }

  const asset = await prisma.asset.findUnique({ where: { id } })
  if (!asset) return apiError(c, 404, 'not_found', `Asset "${id}" is not registered`)

  const source = sourceOverride ?? asset.source

  // Check tick retention for 1h
  const retentionDays = parseInt(process.env.TICK_RETENTION_DAYS ?? '90', 10)
  if (intervalParam === '1h' && from < new Date(Date.now() - retentionDays * 86_400_000)) {
    return apiError(
      c, 400, 'tick_retention_exceeded',
      `interval=1h is only available within the last ${retentionDays} days. Use interval=1d for older ranges.`,
    )
  }

  // Gap detection — backfill only when we have no ticks at all in the requested
  // range. Partial gaps are accepted; sub-second timestamp precision differences
  // are intentionally ignored (ingest cadence is minutes, not milliseconds).
  let didBackfill = false
  const ticksInRange = await prisma.priceTick.count({
    where: { assetId: id, source, timestamp: { gte: from, lte: to } },
  })

  if (ticksInRange === 0) {
    try {
      await backfill(id, source, from, to)
      didBackfill = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return apiError(c, 502, 'upstream_error', `Backfill failed: ${msg}`)
    }
  }

  // Backfilled responses bypass the cache to avoid serving stale data to the next caller
  if (didBackfill) {
    let data: OhlcvPoint[]
    if (intervalParam === '1h') data = await queryHourly(id, source, from, to)
    else if (intervalParam === '1w') data = await queryWeekly(id, from, to, source)
    else data = await queryDaily(id, from, to, source)

    return c.json({
      meta: { fetchedAt: new Date().toISOString(), assetId: id, interval: intervalParam, from: from.toISOString(), to: to.toISOString(), backfilled: true },
      data,
    })
  }

  return withCache(c, 300, async () => {
    let data: OhlcvPoint[]
    if (intervalParam === '1h') data = await queryHourly(id, source, from, to)
    else if (intervalParam === '1w') data = await queryWeekly(id, from, to, source)
    else data = await queryDaily(id, from, to, source)

    return {
      meta: { fetchedAt: new Date().toISOString(), assetId: id, interval: intervalParam, from: from.toISOString(), to: to.toISOString(), backfilled: false },
      data,
    }
  })
})

history.get('/:id/summary', async (c) => {
  const prisma = await prismaPromise
  const id = c.req.param('id')
  const fromStr = c.req.query('from')
  const toStr = c.req.query('to')

  const from = fromStr ? new Date(fromStr) : new Date(Date.now() - 90 * 86_400_000)
  const to = toStr ? new Date(toStr) : new Date()

  const asset = await prisma.asset.findUnique({ where: { id } })
  if (!asset) return apiError(c, 404, 'not_found', `Asset "${id}" is not registered`)

  return withCache(c, 300, async () => {
    const rows = await queryDaily(id, from, to)
    return {
      meta: { fetchedAt: new Date().toISOString(), assetId: id, from: from.toISOString(), to: to.toISOString() },
      data: rows,
    }
  })
})

export default history
