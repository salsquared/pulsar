import { Hono } from 'hono'
import prismaPromise from '../lib/prisma.js'

const health = new Hono()

health.get('/', async (c) => {
  try {
    const prisma = await Promise.race([
      prismaPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000)),
    ])
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DB query timeout')), 1000)),
    ])
    return c.json({ status: 'ok', db: 'ok', uptimeSeconds: Math.floor(process.uptime()) })
  } catch (err) {
    return c.json(
      { status: 'degraded', db: 'error', error: err instanceof Error ? err.message : String(err) },
      503,
    )
  }
})

export default health
