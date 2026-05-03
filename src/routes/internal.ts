import { Hono } from 'hono'
import { internalTokenMiddleware } from '../lib/auth.js'
import { apiError } from '../lib/errors.js'
import { broadcast } from './ws.js'
import type { IngestNotifyBody } from '../types.js'

const internal = new Hono()

internal.post('/notify', internalTokenMiddleware(), async (c) => {
  let body: IngestNotifyBody
  try {
    body = (await c.req.json()) as IngestNotifyBody
  } catch {
    return apiError(c, 400, 'bad_request', 'Request body must be valid JSON')
  }

  if (typeof body.sourceId !== 'string' || !Array.isArray(body.ticks)) {
    return apiError(c, 400, 'bad_request', 'Body must have sourceId (string) and ticks (array)')
  }

  broadcast(body.sourceId, body.ticks)

  return new Response(null, { status: 204 })
})

export default internal
