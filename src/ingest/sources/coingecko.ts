import type { NormalizedTick, SourceConfig } from '../../types.js'
import { logger } from '../../lib/logger.js'

const BASE = 'https://api.coingecko.com/api/v3'

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (process.env.COINGECKO_API_KEY) {
      headers['x-cg-pro-api-key'] = process.env.COINGECKO_API_KEY
    }

    const res = await fetch(url, { headers })

    if (res.ok) return res

    if ((res.status === 429 || res.status === 503) && i < attempts - 1) {
      const delay = Math.min(1000 * 2 ** i + Math.random() * 500, 10_000)
      logger.warn('coingecko rate limited, retrying', { attempt: i + 1, status: res.status, delayMs: Math.round(delay) })
      await new Promise((r) => setTimeout(r, delay))
      continue
    }

    throw new Error(`CoinGecko request failed: ${res.status} ${res.statusText} — ${url}`)
  }
  throw new Error('fetchWithRetry: unreachable')
}

async function fetchTop100(): Promise<NormalizedTick[]> {
  const url = `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`
  const res = await fetchWithRetry(url)
  const data = (await res.json()) as Array<{
    id: string
    current_price: number
    total_volume: number
    market_cap: number
  }>

  const now = new Date()
  return data.map((r) => ({
    assetId: r.id,
    timestamp: now,
    close: r.current_price,
    volume: r.total_volume ?? null,
    open: null,
    high: null,
    low: null,
  }))
}

async function fetchHistory(
  assetId: string,
  from: Date,
  to: Date,
): Promise<NormalizedTick[]> {
  const fromEpoch = Math.floor(from.getTime() / 1000)
  const toEpoch = Math.floor(to.getTime() / 1000)
  const url = `${BASE}/coins/${assetId}/market_chart/range?vs_currency=usd&from=${fromEpoch}&to=${toEpoch}`

  const res = await fetchWithRetry(url)
  const data = (await res.json()) as {
    prices: [number, number][]
    total_volumes: [number, number][]
  }

  // Zip prices + volumes by index (same-length parallel arrays from CoinGecko)
  return data.prices.map(([ts, price], i) => ({
    assetId,
    timestamp: new Date(ts),
    close: price,
    volume: data.total_volumes[i]?.[1] ?? null,
    open: null,
    high: null,
    low: null,
  }))
}

export const coingecko: SourceConfig = {
  id: 'coingecko',
  label: 'CoinGecko',
  assetClass: 'CRYPTO',
  ttl: 300,
  fetch: fetchTop100,
  fetchHistory,
}
