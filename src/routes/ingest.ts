import { Hono } from 'hono'
import { internalTokenMiddleware } from '../lib/auth.js'
import { apiError } from '../lib/errors.js'
import { runIngest } from '../ingest/pipeline.js'
import { SOURCES } from '../lib/source-registry.js'

const ingest = new Hono()

ingest.post('/:sourceId', internalTokenMiddleware(), async (c) => {
  const sourceId = c.req.param('sourceId') ?? ''

  if (!sourceId || !SOURCES[sourceId]) {
    return apiError(c, 404, 'not_found', `Unknown source "${sourceId}"`)
  }

  const fetchedAt = new Date().toISOString()
  const start = Date.now()

  try {
    const result = await runIngest(sourceId)
    return c.json({
      meta: { fetchedAt, sourceId, durationMs: Date.now() - start },
      data: { rowsInserted: result.rowsInserted, status: result.status },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return apiError(c, 502, 'upstream_error', `Ingest failed: ${errorMsg}`, { errorMsg })
  }
})

export default ingest
