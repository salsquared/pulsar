// Yahoo Finance fetcher — EQUITY + COMMODITY assets (curated, no auto-register).
// Asset IDs match Yahoo Finance symbols exactly: AAPL, ^GSPC, GC=F, etc.
// These must be pre-registered in the Asset table (see prisma/seed.ts).
//
// Both fetch() and fetchHistory() use the v8/finance/chart endpoint.
// The v7/quote endpoint now requires cookie-based auth.
// Free tier; no API key required.

import type { NormalizedTick, SourceConfig } from '../../types.js'
import { logger } from '../../lib/logger.js'

const SYMBOLS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'SPY', 'QQQ',
  '^GSPC', '^DJI', '^IXIC',
  'GC=F', 'SI=F', 'CL=F', 'NG=F',
]

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
}

type ChartResponse = {
  chart: {
    result: Array<{
      timestamp: number[]
      indicators: {
        quote: Array<{
          open: (number | null)[]
          high: (number | null)[]
          low: (number | null)[]
          close: (number | null)[]
          volume: (number | null)[]
        }>
      }
    }> | null
    error: { code: string; description: string } | null
  }
}

async function fetchChart(
  symbol: string,
  params: Record<string, string>,
  attempts = 3,
): Promise<ChartResponse> {
  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url.toString(), { headers: HEADERS })
    if (res.ok) return (await res.json()) as ChartResponse

    if (res.status === 429 && i < attempts - 1) {
      const delay = Math.min(2000 * 2 ** i + Math.random() * 500, 15_000)
      logger.warn('yahoo rate limited, retrying', { symbol, attempt: i + 1, delayMs: Math.round(delay) })
      await new Promise((r) => setTimeout(r, delay))
      continue
    }

    throw new Error(`Yahoo Finance chart failed for ${symbol}: ${res.status} ${res.statusText}`)
  }
  throw new Error('fetchChart: unreachable')
}

function parseChart(assetId: string, data: ChartResponse): NormalizedTick[] {
  if (data.chart.error) {
    throw new Error(`Yahoo Finance error for ${assetId}: ${data.chart.error.description}`)
  }
  if (!data.chart.result?.length) return []

  const result = data.chart.result[0]
  const quote = result.indicators.quote[0]

  return result.timestamp
    .map((ts, i) => ({
      assetId,
      timestamp: new Date(ts * 1000),
      open: quote.open[i] ?? null,
      high: quote.high[i] ?? null,
      low: quote.low[i] ?? null,
      close: quote.close[i] as number,
      volume: quote.volume[i] ?? null,
    }))
    .filter((t) => t.close != null)
}

async function fetchQuotes(): Promise<NormalizedTick[]> {
  const ticks: NormalizedTick[] = []

  for (const symbol of SYMBOLS) {
    const data = await fetchChart(symbol, { range: '5d', interval: '1d' })
    const parsed = parseChart(symbol, data)
    // Take only the most recent point — this is the "current" price tick
    if (parsed.length > 0) ticks.push(parsed[parsed.length - 1])
  }

  return ticks
}

async function fetchHistory(assetId: string, from: Date, to: Date): Promise<NormalizedTick[]> {
  const period1 = String(Math.floor(from.getTime() / 1000))
  const period2 = String(Math.floor(to.getTime() / 1000))
  const data = await fetchChart(assetId, { period1, period2, interval: '1d' })
  return parseChart(assetId, data)
}

export const yahoo: SourceConfig = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  assetClass: 'EQUITY',
  ttl: 300,
  fetch: fetchQuotes,
  fetchHistory,
}
