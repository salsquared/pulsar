import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import type { WebSocket } from 'ws'
import type { NodeWebSocket } from '@hono/node-ws'
import type { IngestNotifyBody, ServerMessage, ClientMessage } from '../types.js'
import { logger } from '../lib/logger.js'

interface Session {
  id: string
  ws: WSContext<WebSocket>
  subscribed: Set<string>
  queue: number       // messages sent but not yet flushed (backpressure guard)
  missedPongs: number
}

const sessions = new Map<string, Session>()
const MAX_SUBS = parseInt(process.env.WS_MAX_SUBSCRIPTIONS ?? '500', 10)

// Heartbeat: ping every 30 s, close after 2 consecutive missed pongs.
setInterval(() => {
  for (const [id, s] of sessions.entries()) {
    if (++s.missedPongs >= 2) {
      logger.warn('ws heartbeat timeout', { sessionId: id })
      s.ws.close(1006, 'heartbeat timeout')
      sessions.delete(id)
      continue
    }
    s.ws.raw?.ping()
  }
}, 30_000)

// Called by /internal/notify to fan ticks out to subscribed WS clients.
export function broadcast(sourceId: string, ticks: IngestNotifyBody['ticks']): void {
  if (sessions.size === 0) return

  for (const tick of ticks) {
    const frame: ServerMessage = {
      type: 'tick',
      assetId: tick.assetId,
      tick: {
        timestamp: tick.timestamp,
        open: tick.open,
        high: tick.high,
        low: tick.low,
        close: tick.close,
        volume: tick.volume,
        source: sourceId,
      },
    }
    const msg = JSON.stringify(frame)

    for (const [id, s] of sessions.entries()) {
      if (!s.subscribed.has('*') && !s.subscribed.has(tick.assetId)) continue
      if (s.queue >= 256) {
        logger.warn('ws client overload — closing', { sessionId: id })
        s.ws.close(1009, 'overload')
        sessions.delete(id)
        continue
      }
      s.queue++
      // Use raw send to track flush via callback; fall back to WSContext.send if unavailable.
      if (s.ws.raw) {
        s.ws.raw.send(msg, () => { s.queue-- })
      } else {
        s.ws.send(msg)
        s.queue--
      }
    }
  }
}

export function createWsRoute(upgradeWebSocket: NodeWebSocket['upgradeWebSocket']): Hono {
  const router = new Hono()

  router.get(
    '/',
    upgradeWebSocket((c) => {
      let sessionId = ''

      return {
        onOpen(_evt, ws) {
          sessionId = crypto.randomUUID()
          const session: Session = {
            id: sessionId,
            ws,
            subscribed: new Set(),
            queue: 0,
            missedPongs: 0,
          }
          sessions.set(sessionId, session)

          ws.raw?.on('pong', () => {
            const s = sessions.get(sessionId)
            if (s) s.missedPongs = 0
          })

          const welcome: ServerMessage = {
            type: 'welcome',
            sessionId,
            serverTime: new Date().toISOString(),
          }
          ws.send(JSON.stringify(welcome))
          logger.info('ws session opened', { sessionId })
        },

        onMessage(evt, ws) {
          let msg: ClientMessage
          try {
            msg = JSON.parse(String(evt.data)) as ClientMessage
          } catch {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_message', message: 'Invalid JSON' } satisfies ServerMessage))
            return
          }

          const session = sessions.get(sessionId)
          if (!session) return

          if (msg.type === 'subscribe') {
            const incoming = msg.assetIds ?? []
            const newCount = incoming.filter((id) => !session.subscribed.has(id)).length
            if (session.subscribed.size + newCount > MAX_SUBS) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'subscription_limit',
                message: `Max ${MAX_SUBS} subscriptions per connection`,
              } satisfies ServerMessage))
              return
            }
            for (const id of incoming) session.subscribed.add(id)
            ws.send(JSON.stringify({ type: 'subscribed', assetIds: [...session.subscribed] } satisfies ServerMessage))
          } else if (msg.type === 'unsubscribe') {
            const ids = msg.assetIds ?? []
            if (ids.length === 0 || ids.includes('*')) {
              session.subscribed.clear()
            } else {
              for (const id of ids) session.subscribed.delete(id)
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', code: 'unknown_type', message: 'Unknown message type' } satisfies ServerMessage))
          }
        },

        onClose() {
          sessions.delete(sessionId)
          logger.info('ws session closed', { sessionId })
        },

        onError() {
          sessions.delete(sessionId)
        },
      }
    }),
  )

  return router
}
