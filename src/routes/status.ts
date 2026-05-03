import { Hono } from 'hono'
import { statSync } from 'fs'
import prismaPromise from '../lib/prisma.js'

const status = new Hono()

status.get('/', async (c) => {
  const prisma = await prismaPromise

  const [jobs, assetCount, tickCount, summaryCount, macroCount] = await Promise.all([
    prisma.ingestJob.findMany({ orderBy: { startedAt: 'desc' }, take: 200 }),
    prisma.asset.count(),
    prisma.priceTick.count(),
    prisma.dailySummary.count(),
    prisma.macroSeries.count(),
  ])

  // Aggregate per-source stats from recent jobs
  const sourceMap = new Map<
    string,
    { lastSuccessAt: string | null; lastFailureAt: string | null; lastStatus: string | null; consecutiveFailures: number }
  >()

  // Process in reverse-chron order to build consecutive-failures count
  for (const job of jobs) {
    if (!sourceMap.has(job.sourceId)) {
      sourceMap.set(job.sourceId, {
        lastSuccessAt: job.status === 'SUCCESS' ? job.completedAt?.toISOString() ?? null : null,
        lastFailureAt: job.status === 'FAILED' ? job.completedAt?.toISOString() ?? null : null,
        lastStatus: job.status,
        consecutiveFailures: 0,
      })
    }
  }

  // Count consecutive failures (most recent jobs first, already sorted)
  for (const [sourceId, stats] of sourceMap.entries()) {
    let count = 0
    for (const job of jobs) {
      if (job.sourceId !== sourceId) continue
      if (job.status === 'FAILED') count++
      else break
    }
    stats.consecutiveFailures = count
  }

  // DB file sizes
  const dbUrl = process.env.DATABASE_URL ?? ''
  const dbPath = dbUrl.replace('file:', '').replace(/^\.\//, `${process.cwd()}/prisma/`)
  let sizeBytes = 0
  let walSizeBytes = 0
  try {
    sizeBytes = statSync(dbPath).size
    walSizeBytes = statSync(dbPath + '-wal').size
  } catch {
    // file may not exist yet or WAL may be empty
  }

  return c.json({
    meta: { fetchedAt: new Date().toISOString() },
    data: {
      sources: [...sourceMap.entries()].map(([sourceId, s]) => ({ sourceId, ...s })),
      counts: { assets: assetCount, priceTicks: tickCount, dailySummaries: summaryCount, macroSeries: macroCount },
      db: { sizeBytes, walSizeBytes },
    },
  })
})

status.get('/jobs', async (c) => {
  const prisma = await prismaPromise
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 500)
  const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : undefined
  const sourceFilter = c.req.query('source')

  const jobs = await prisma.ingestJob.findMany({
    where: {
      ...(cursor ? { id: { lt: cursor } } : {}),
      ...(sourceFilter ? { sourceId: sourceFilter } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
  })

  const hasMore = jobs.length > limit
  const page = hasMore ? jobs.slice(0, limit) : jobs
  const nextCursor = hasMore ? String(page[page.length - 1].id) : null

  return c.json({
    meta: { fetchedAt: new Date().toISOString(), limit, nextCursor },
    data: page.map((j) => ({
      id: j.id,
      sourceId: j.sourceId,
      startedAt: j.startedAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
      status: j.status,
      rowsInserted: j.rowsInserted,
      errorMsg: j.errorMsg ?? null,
    })),
  })
})

export default status
