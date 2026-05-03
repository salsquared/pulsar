process.env.PROC = 'api'

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { logger } from './lib/logger.js'
import prismaPromise from './lib/prisma.js'
import health from './routes/health.js'
import assets from './routes/assets.js'
import prices from './routes/prices.js'
import history from './routes/history.js'
import status from './routes/status.js'

const app = new Hono()

// Health at root (Cloudflare Tunnel probes don't need the /api prefix)
app.route('/health', health)

// Public REST API
const api = new Hono()
api.route('/assets', assets)
api.route('/prices', prices)
api.route('/history', history)
api.route('/status', status)

app.route('/api', api)

// 404 fallback
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404))

const port = Number(process.env.PORT ?? 4103)

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info('listening', { port: info.port })
})

// Graceful shutdown — closeAllConnections() forces keep-alive connections to
// drop immediately so the port is released before tsx --watch spawns the new process.
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down')
  server.closeAllConnections()
  server.close(async () => {
    const prisma = await prismaPromise
    await prisma.$disconnect()
    process.exit(0)
  })
})
