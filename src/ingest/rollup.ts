// Nightly rollup: aggregates PriceTick rows into DailySummary, then prunes
// PriceTick rows older than TICK_RETENTION_DAYS. Run via PM2 cron at 00:30 UTC.
// Re-running is safe — daily summaries are upserted; pruning is idempotent.

process.env.PROC = 'rollup'

import prismaPromise from '../lib/prisma.js'
import { logger } from '../lib/logger.js'

interface DayRow {
  day: string                  // 'YYYY-MM-DD' (UTC)
  o: number | null
  h: number | null
  l: number | null
  c: number | null
  v: number | null
}

const retentionDays = parseInt(process.env.TICK_RETENTION_DAYS ?? '90', 10)
const prisma = await prismaPromise

let exitCode = 0
let assetsProcessed = 0
let summariesUpserted = 0
let ticksDeleted = 0

try {
  const assets = await prisma.asset.findMany({ where: { active: true } })

  // "Today" UTC midnight — only roll up days that are fully complete.
  const now = new Date()
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  for (const asset of assets) {
    // Start at the latest summary's day (re-process in case late ticks landed),
    // or fall back to the oldest tick's day if no summary exists yet.
    const latest = await prisma.dailySummary.findFirst({
      where: { assetId: asset.id },
      orderBy: { date: 'desc' },
      select: { date: true },
    })

    let startMs: number
    if (latest) {
      startMs = latest.date.getTime()
    } else {
      const oldest = await prisma.priceTick.findFirst({
        where: { assetId: asset.id, source: asset.source },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      })
      if (!oldest) {
        assetsProcessed++
        continue
      }
      const t = oldest.timestamp
      startMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
    }

    if (startMs >= endMs) {
      assetsProcessed++
      continue
    }

    // Aggregate by day in a single window-function query (primary source only).
    // open  = first tick.close of the day
    // close = last tick.close of the day
    // high  = max(close, COALESCE(high, close)) across the day
    // low   = min(close, COALESCE(low, close)) across the day
    const rows = await prisma.$queryRaw<DayRow[]>`
      WITH ranked AS (
        SELECT
          strftime('%Y-%m-%d', "timestamp" / 1000, 'unixepoch') AS day,
          close,
          high,
          low,
          volume,
          ROW_NUMBER() OVER (
            PARTITION BY strftime('%Y-%m-%d', "timestamp" / 1000, 'unixepoch')
            ORDER BY "timestamp" ASC
          ) AS rn_asc,
          ROW_NUMBER() OVER (
            PARTITION BY strftime('%Y-%m-%d', "timestamp" / 1000, 'unixepoch')
            ORDER BY "timestamp" DESC
          ) AS rn_desc
        FROM "PriceTick"
        WHERE "assetId" = ${asset.id}
          AND "source"  = ${asset.source}
          AND "timestamp" >= ${startMs}
          AND "timestamp" <  ${endMs}
      )
      SELECT
        day,
        MAX(CASE WHEN rn_asc = 1 THEN close END)                                              AS o,
        MAX(CASE WHEN high IS NOT NULL AND high > close THEN high ELSE close END)             AS h,
        MIN(CASE WHEN low  IS NOT NULL AND low  < close THEN low  ELSE close END)             AS l,
        MAX(CASE WHEN rn_desc = 1 THEN close END)                                             AS c,
        SUM(volume)                                                                           AS v
      FROM ranked
      GROUP BY day
      ORDER BY day ASC
    `

    for (const r of rows) {
      if (r.o === null || r.c === null || r.h === null || r.l === null) continue
      const date = new Date(r.day + 'T00:00:00Z')
      await prisma.dailySummary.upsert({
        where: { assetId_date: { assetId: asset.id, date } },
        create: { assetId: asset.id, date, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v },
        update: { open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v },
      })
      summariesUpserted++
    }

    assetsProcessed++
  }

  // Tick retention prune — must run AFTER rollup so we don't lose data.
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const result = await prisma.priceTick.deleteMany({
    where: { timestamp: { lt: cutoff } },
  })
  ticksDeleted = result.count

  logger.info('rollup_complete', { assetsProcessed, summariesUpserted, ticksDeleted, retentionDays })
} catch (err) {
  logger.error('rollup failed', { error: err instanceof Error ? err.message : String(err) })
  exitCode = 1
} finally {
  await prisma.$disconnect()
}

process.exit(exitCode)
