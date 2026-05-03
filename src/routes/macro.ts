import { Hono } from 'hono'
import prismaPromise from '../lib/prisma.js'
import { withCache } from '../lib/cache.js'
import { apiError } from '../lib/errors.js'

const macro = new Hono()

// GET /macro — latest value per series (one entry per seriesId)
macro.get('/', async (c) => {
  const prisma = await prismaPromise

  return withCache(c, 86400, async () => {
    // SQLite has no DISTINCT ON; use a self-join to pick the max-timestamp row per seriesId.
    const rows = await prisma.$queryRaw<
      Array<{ id: number; seriesId: string; name: string; value: number; timestamp: bigint; source: string }>
    >`
      SELECT m.id, m."seriesId", m.name, m.value, m."timestamp", m.source
      FROM "MacroSeries" m
      INNER JOIN (
        SELECT "seriesId", MAX("timestamp") AS maxTs
        FROM "MacroSeries"
        GROUP BY "seriesId"
      ) latest ON m."seriesId" = latest."seriesId" AND m."timestamp" = latest.maxTs
      ORDER BY m."seriesId" ASC
    `

    return {
      meta: { fetchedAt: new Date().toISOString(), count: rows.length },
      data: rows.map((r) => ({
        seriesId: r.seriesId,
        name: r.name,
        value: r.value,
        timestamp: new Date(Number(r.timestamp)).toISOString(),
        source: r.source,
      })),
    }
  })
})

// GET /macro/:seriesId — full history for one series (optional from/to)
macro.get('/:seriesId', async (c) => {
  const prisma = await prismaPromise
  const seriesId = c.req.param('seriesId')
  const fromStr = c.req.query('from')
  const toStr = c.req.query('to')

  const from = fromStr ? new Date(fromStr) : new Date(0)
  const to = toStr ? new Date(toStr) : new Date()

  if ((fromStr && isNaN(from.getTime())) || (toStr && isNaN(to.getTime()))) {
    return apiError(c, 400, 'bad_request', 'Invalid date format — use ISO 8601')
  }

  const exists = await prisma.macroSeries.findFirst({ where: { seriesId }, select: { seriesId: true } })
  if (!exists) return apiError(c, 404, 'not_found', `Macro series "${seriesId}" not found`)

  return withCache(c, 86400, async () => {
    const rows = await prisma.macroSeries.findMany({
      where: { seriesId, timestamp: { gte: from, lte: to } },
      orderBy: { timestamp: 'asc' },
    })

    return {
      meta: {
        fetchedAt: new Date().toISOString(),
        seriesId,
        from: fromStr ? from.toISOString() : null,
        to: toStr ? to.toISOString() : null,
      },
      data: rows.map((r) => ({
        timestamp: r.timestamp.toISOString(),
        value: r.value,
      })),
    }
  })
})

export default macro
