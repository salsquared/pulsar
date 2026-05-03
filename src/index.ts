process.env.PROC = 'api'

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { logger } from './lib/logger.js'
import prismaPromise from './lib/prisma.js'
import health from './routes/health.js'
import assets from './routes/assets.js'
import prices from './routes/prices.js'
import history from './routes/history.js'
import macro from './routes/macro.js'
import status from './routes/status.js'
import internal from './routes/internal.js'
import ingest from './routes/ingest.js'
import { createWsRoute } from './routes/ws.js'

const app = new Hono()

// createNodeWebSocket must be called with the app instance before routes are mounted.
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

// Health at root (Cloudflare Tunnel probes don't need the /api prefix)
app.route('/health', health)

// WebSocket — outside /api prefix so ws:// clients don't need it
app.route('/ws/prices', createWsRoute(upgradeWebSocket))

// Cross-process notify — called by ingest jobs
app.route('/internal', internal)

// Public REST API
const api = new Hono()
api.route('/assets', assets)
api.route('/prices', prices)
api.route('/history', history)
api.route('/macro', macro)
api.route('/status', status)
api.route('/ingest', ingest)

app.route('/api', api)

// 404 fallback
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404))

const port = Number(process.env.PORT ?? 4103)

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info('listening', { port: info.port })
})

// injectWebSocket hooks the WS upgrade handler into the HTTP server.
// Must be called after serve() returns the server instance.
injectWebSocket(server)

// Graceful shutdown — closeAllConnections() forces keep-alive connections to
// drop immediately so the port is released before tsx --watch spawns the new process.
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down')
  if ('closeAllConnections' in server) server.closeAllConnections()
  server.close(async () => {
    const prisma = await prismaPromise
    await prisma.$disconnect()
    process.exit(0)
  })
})
