// Best-effort cross-process notification. Ingest jobs call this after inserting
// ticks so the API process can fan them out over WebSocket. All errors are
// swallowed and logged — a network failure must never crash an ingest job.

import type { IngestNotifyBody, NormalizedTick } from '../types.js'
import { logger } from './logger.js'

export async function notifyApi(sourceId: string, ticks: NormalizedTick[]): Promise<void> {
  const token = process.env.PULSAR_INTERNAL_TOKEN
  if (!token) {
    logger.warn('notifyApi skipped — PULSAR_INTERNAL_TOKEN not set', { sourceId })
    return
  }

  const port = process.env.PORT ?? '3103'
  const body: IngestNotifyBody = {
    sourceId,
    ticks: ticks.map((t) => ({
      assetId: t.assetId,
      timestamp: t.timestamp.toISOString(),
      open: t.open ?? null,
      high: t.high ?? null,
      low: t.low ?? null,
      close: t.close,
      volume: t.volume ?? null,
    })),
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      logger.warn('notifyApi HTTP error', { sourceId, status: res.status })
    }
  } catch (err) {
    logger.warn('notifyApi network error — API server may be down', {
      sourceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
