import type { JobStatus, NormalizedTick } from '../types.js'
import { getSource } from '../lib/source-registry.js'
import { logger } from '../lib/logger.js'
import prismaPromise from '../lib/prisma.js'
import { notifyApi } from '../lib/notify.js'

// ─── SQLite batch insert helpers ─────────────────────────────────────────────
// Prisma 6 removed skipDuplicates for SQLite createMany. Use INSERT OR IGNORE instead.
// Timestamps must be written in Prisma's storage format ("YYYY-MM-DD HH:MM:SS[.SSS] UTC")
// so ORM range queries (e.g. timestamp <= now) work without raw-SQL workarounds.
// See src/lib/datetime.ts for the format rationale.

import type { PrismaClient } from '@prisma/client'
import { toPrismaDateTime } from '../lib/datetime.js'

async function insertPriceTicksOrIgnore(
  prisma: PrismaClient,
  rows: Array<{
    assetId: string
    timestamp: Date
    open: number | null
    high: number | null
    low: number | null
    close: number
    volume: number | null
    source: string
  }>,
): Promise<number> {
  if (rows.length === 0) return 0

  const cols = ['assetId', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'source']
  // SQLite's default variable limit. With 8 columns, max 124 rows per statement.
  const BATCH = 124
  let total = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const ph = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const vals: unknown[] = batch.flatMap((r) => [
      r.assetId,
      toPrismaDateTime(r.timestamp),
      r.open,
      r.high,
      r.low,
      r.close,
      r.volume,
      r.source,
    ])
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "PriceTick" ("assetId","timestamp","open","high","low","close","volume","source") VALUES ${ph}`,
      ...vals,
    )
    total += batch.length
  }

  return total
}

async function insertMacroOrIgnore(
  prisma: PrismaClient,
  rows: Array<{ seriesId: string; name: string; value: number; timestamp: Date; source: string }>,
): Promise<number> {
  if (rows.length === 0) return 0

  const BATCH = 199 // 5 cols → floor(999/5) = 199
  let total = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const ph = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
    const vals: unknown[] = batch.flatMap((r) => [
      r.seriesId, r.name, r.value, toPrismaDateTime(r.timestamp), r.source,
    ])
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "MacroSeries" ("seriesId","name","value","timestamp","source") VALUES ${ph}`,
      ...vals,
    )
    total += batch.length
  }

  return total
}

// ─── Backfill in-flight coalescing map ────────────────────────────────────────
// Keyed by `${assetId}:${source}:${floorDay(from)}..${ceilDay(to)}`.
// Lives in API process only — backfills never run inside cron ingest jobs.
const inflight = new Map<string, Promise<void>>()

function floorDay(d: Date): string {
  return new Date(Math.floor(d.getTime() / 86_400_000) * 86_400_000).toISOString().slice(0, 10)
}

function ceilDay(d: Date): string {
  return new Date(Math.ceil(d.getTime() / 86_400_000) * 86_400_000).toISOString().slice(0, 10)
}

// ─── runIngest ────────────────────────────────────────────────────────────────

export async function runIngest(sourceId: string): Promise<{
  rowsInserted: number
  status: JobStatus
  errorMsg?: string
}> {
  const prisma = await prismaPromise
  const source = getSource(sourceId)

  const job = await prisma.ingestJob.create({
    data: { sourceId, startedAt: new Date(), status: 'RUNNING', rowsInserted: 0 },
  })

  try {
    if (!source.fetch && !source.fetchMacro) {
      throw new Error(`Source "${sourceId}" has no fetch or fetchMacro method`)
    }

    // ── Macro path (FRED etc.) ────────────────────────────────────────────────
    if (source.fetchMacro) {
      const macroRows = await source.fetchMacro()
      const count = await insertMacroOrIgnore(prisma, macroRows.map((r) => ({ ...r, source: sourceId })))

      await prisma.ingestJob.update({
        where: { id: job.id },
        data: { status: 'SUCCESS', completedAt: new Date(), rowsInserted: count },
      })
      logger.info('ingest complete', { sourceId, rowsInserted: count })
      return { rowsInserted: count, status: 'SUCCESS' }
    }

    // ── Tick path ─────────────────────────────────────────────────────────────
    const ticks = await source.fetch!()

    // Asset registration: CRYPTO sources auto-upsert; others must already exist.
    const uniqueAssetIds = [...new Set(ticks.map((t) => t.assetId))]

    if (source.assetClass === 'CRYPTO') {
      // For each unique asset, take the first tick's metadata (symbol/name) if present.
      // Falls back to assetId-derived placeholders when the source doesn't carry metadata.
      const meta = new Map<string, { symbol: string; name: string }>()
      for (const t of ticks) {
        if (meta.has(t.assetId)) continue
        meta.set(t.assetId, {
          symbol: t.symbol ?? t.assetId.toUpperCase().replace(/-/g, '').slice(0, 10),
          name: t.name ?? t.assetId,
        })
      }
      for (const id of uniqueAssetIds) {
        const m = meta.get(id)!
        await prisma.asset.upsert({
          where: { id },
          create: {
            id,
            symbol: m.symbol,
            name: m.name,
            assetClass: 'CRYPTO',
            source: sourceId,
            active: true,
          },
          // Refresh metadata on every run — keeps name/symbol up to date if upstream changes.
          update: { symbol: m.symbol, name: m.name },
        })
      }
    } else {
      const registered = await prisma.asset.findMany({
        where: { id: { in: uniqueAssetIds } },
        select: { id: true },
      })
      const registeredIds = new Set(registered.map((a) => a.id))
      const dropped = uniqueAssetIds.filter((id) => !registeredIds.has(id))
      for (const id of dropped) {
        logger.warn('unregistered asset — tick dropped', { sourceId, assetId: id })
      }
      // Filter ticks to registered assets only
      ticks.splice(0, ticks.length, ...ticks.filter((t) => registeredIds.has(t.assetId)))
    }

    const count = await insertPriceTicksOrIgnore(
      prisma,
      ticks.map((t) => ({
        assetId: t.assetId,
        timestamp: t.timestamp,
        open: t.open ?? null,
        high: t.high ?? null,
        low: t.low ?? null,
        close: t.close,
        volume: t.volume ?? null,
        source: sourceId,
      })),
    )

    await notifyApi(sourceId, ticks).catch(() => {})

    await prisma.ingestJob.update({
      where: { id: job.id },
      data: { status: 'SUCCESS', completedAt: new Date(), rowsInserted: count },
    })

    logger.info('ingest complete', { sourceId, rowsInserted: count })
    return { rowsInserted: count, status: 'SUCCESS' }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await prisma.ingestJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', completedAt: new Date(), errorMsg },
    })
    logger.error('ingest failed', { sourceId, error: errorMsg })
    throw err
  }
}

// ─── backfill ─────────────────────────────────────────────────────────────────

export async function backfill(
  assetId: string,
  sourceId: string,
  from: Date,
  to: Date,
): Promise<void> {
  const source = getSource(sourceId)
  if (!source.fetchHistory) {
    throw new Error(`Source "${sourceId}" does not support historical backfill`)
  }

  const key = `${assetId}:${sourceId}:${floorDay(from)}..${ceilDay(to)}`

  const existing = inflight.get(key)
  if (existing) {
    logger.info('backfill coalesced — awaiting in-flight fetch', { assetId, sourceId, key })
    return existing
  }

  const work = (async () => {
    logger.info('backfill started', { assetId, sourceId, from: from.toISOString(), to: to.toISOString() })
    const prisma = await prismaPromise
    const ticks = await source.fetchHistory!(assetId, from, to)
    await insertPriceTicksOrIgnore(
      prisma,
      ticks.map((t) => ({
        assetId: t.assetId,
        timestamp: t.timestamp,
        open: t.open ?? null,
        high: t.high ?? null,
        low: t.low ?? null,
        close: t.close,
        volume: t.volume ?? null,
        source: sourceId,
      })),
    )
    logger.info('backfill complete', { assetId, sourceId, ticks: ticks.length })
  })().finally(() => inflight.delete(key))

  inflight.set(key, work)
  return work
}
