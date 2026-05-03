import { Hono } from 'hono'
import prismaPromise from '../lib/prisma.js'
import { withCache } from '../lib/cache.js'
import { apiError } from '../lib/errors.js'
import type { AssetClass, PricePoint } from '../types.js'

const prices = new Hono()

async function buildPricePoint(
  assetId: string,
  symbol: string,
  name: string,
  assetClass: AssetClass,
  primarySource: string,
): Promise<PricePoint | null> {
  const prisma = await prismaPromise

  const latest = await prisma.priceTick.findFirst({
    where: { assetId, source: primarySource },
    orderBy: { timestamp: 'desc' },
  })

  if (!latest) return null

  const now = latest.timestamp.getTime()
  const prior = await prisma.priceTick.findFirst({
    where: {
      assetId,
      source: primarySource,
      timestamp: { gte: new Date(now - 25 * 3_600_000), lte: new Date(now - 23 * 3_600_000) },
    },
    orderBy: { timestamp: 'desc' },
  })

  const change24h = prior !== null ? ((latest.close - prior.close) / prior.close) * 100 : null

  return {
    assetId,
    symbol,
    name,
    assetClass,
    close: latest.close,
    change24h,
    volume: latest.volume,
    source: primarySource,
    timestamp: latest.timestamp.toISOString(),
  }
}

const VALID_CLASSES: ReadonlySet<AssetClass> = new Set(['CRYPTO', 'EQUITY', 'FOREX', 'COMMODITY', 'MACRO'])

prices.get('/latest', async (c) => {
  const classRaw = c.req.query('class')?.toUpperCase()
  const idsFilter = c.req.query('ids')?.split(',').filter(Boolean)

  if (classRaw && !VALID_CLASSES.has(classRaw as AssetClass)) {
    return apiError(c, 400, 'bad_request', `Invalid class "${classRaw}". Must be one of: ${[...VALID_CLASSES].join(', ')}`)
  }
  const classFilter = classRaw as AssetClass | undefined

  return withCache(c, 60, async () => {
    const prisma = await prismaPromise
    const assetList = await prisma.asset.findMany({
      where: {
        active: true,
        ...(classFilter ? { assetClass: classFilter } : {}),
        ...(idsFilter?.length ? { id: { in: idsFilter } } : {}),
      },
    })

    const points = (
      await Promise.all(
        assetList.map((a) =>
          buildPricePoint(a.id, a.symbol, a.name, a.assetClass as AssetClass, a.source),
        ),
      )
    ).filter((p): p is PricePoint => p !== null)

    return { meta: { fetchedAt: new Date().toISOString(), count: points.length }, data: points }
  })
})

prices.get('/:id', async (c) => {
  const id = c.req.param('id')
  return withCache(c, 60, async () => {
    const prisma = await prismaPromise
    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) return apiError(c, 404, 'not_found', `Asset "${id}" is not registered`)

    const point = await buildPricePoint(id, asset.symbol, asset.name, asset.assetClass as AssetClass, asset.source)
    if (!point) return apiError(c, 404, 'not_found', `No ticks yet for asset "${id}"`)

    return { meta: { fetchedAt: new Date().toISOString() }, data: point }
  })
})

export default prices
