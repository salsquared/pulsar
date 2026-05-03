import { Hono } from 'hono'
import prismaPromise from '../lib/prisma.js'
import { withCache } from '../lib/cache.js'
import { apiError } from '../lib/errors.js'
import type { AssetClass } from '../types.js'

const assets = new Hono()

assets.get('/', async (c) => {
  const classFilter = c.req.query('class')?.toUpperCase() as AssetClass | undefined
  return withCache(c, 60, async () => {
    const prisma = await prismaPromise
    const data = await prisma.asset.findMany({
      where: { active: true, ...(classFilter ? { assetClass: classFilter } : {}) },
      orderBy: [{ assetClass: 'asc' }, { id: 'asc' }],
    })
    return { meta: { fetchedAt: new Date().toISOString() }, data }
  })
})

assets.get('/:id', async (c) => {
  const id = c.req.param('id')
  return withCache(c, 60, async () => {
    const prisma = await prismaPromise
    const asset = await prisma.asset.findUnique({ where: { id } })
    if (!asset) return apiError(c, 404, 'not_found', `Asset "${id}" is not registered`)

    const agg = await prisma.priceTick.aggregate({
      where: { assetId: id },
      _min: { timestamp: true },
      _max: { timestamp: true },
      _count: true,
    })

    return {
      meta: { fetchedAt: new Date().toISOString() },
      data: {
        ...asset,
        firstTickAt: agg._min.timestamp?.toISOString() ?? null,
        lastTickAt: agg._max.timestamp?.toISOString() ?? null,
        tickCount: agg._count,
      },
    }
  })
})

export default assets
