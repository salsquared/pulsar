// FOREX pairs fetched from ExchangeRate-API v6 (base = USD).
// Pair values are derived from the USD-base rates:
//   EUR/USD = 1 / rates.EUR   (how many USD per 1 EUR)
//   GBP/USD = 1 / rates.GBP
//   USD/JPY = rates.JPY       (USD is already the base)
//   USD/CHF = rates.CHF
//   AUD/USD = 1 / rates.AUD
// These asset IDs must match the seed (e.g. 'EUR/USD', 'USD/JPY').
// Free tier: ~1500 requests/month → run at most hourly.

import type { NormalizedTick, SourceConfig } from '../../types.js'

const PAIRS: Array<{ assetId: string; rate: (r: Record<string, number>) => number }> = [
  { assetId: 'EUR/USD', rate: (r) => 1 / r.EUR },
  { assetId: 'GBP/USD', rate: (r) => 1 / r.GBP },
  { assetId: 'USD/JPY', rate: (r) => r.JPY },
  { assetId: 'USD/CHF', rate: (r) => r.CHF },
  { assetId: 'AUD/USD', rate: (r) => 1 / r.AUD },
]

async function fetchRates(): Promise<NormalizedTick[]> {
  const key = process.env.EXCHANGERATE_API_KEY
  if (!key) throw new Error('EXCHANGERATE_API_KEY is not set')

  const res = await fetch(`https://v6.exchangerate-api.com/v6/${key}/latest/USD`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`ExchangeRate-API request failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    result: string
    conversion_rates: Record<string, number>
    time_last_update_unix: number
  }

  if (data.result !== 'success') {
    throw new Error(`ExchangeRate-API returned non-success result: ${data.result}`)
  }

  const rates = data.conversion_rates
  const timestamp = new Date(data.time_last_update_unix * 1000)

  return PAIRS.map(({ assetId, rate }) => ({
    assetId,
    timestamp,
    close: rate(rates),
    open: null,
    high: null,
    low: null,
    volume: null,
  }))
}

export const exchangerate: SourceConfig = {
  id: 'exchangerate',
  label: 'ExchangeRate-API',
  assetClass: 'FOREX',
  ttl: 3600,
  fetch: fetchRates,
}
