// Bitcoin fee tier asset IDs (auto-register as CRYPTO, same pattern as CoinGecko):
//   btc-fee-fast   = next-block fastest fee (sat/vB)
//   btc-fee-30min  = ~30 min confirmation fee
//   btc-fee-eco    = economy / slow fee

import type { NormalizedTick, SourceConfig } from '../../types.js'

const URL = 'https://mempool.space/api/v1/fees/recommended'

async function fetchFees(): Promise<NormalizedTick[]> {
  const res = await fetch(URL, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Mempool.space request failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    fastestFee: number
    halfHourFee: number
    economyFee: number
  }

  const now = new Date()
  return [
    { assetId: 'btc-fee-fast',  timestamp: now, close: data.fastestFee,  open: null, high: null, low: null, volume: null },
    { assetId: 'btc-fee-30min', timestamp: now, close: data.halfHourFee, open: null, high: null, low: null, volume: null },
    { assetId: 'btc-fee-eco',   timestamp: now, close: data.economyFee,  open: null, high: null, low: null, volume: null },
  ]
}

export const mempool: SourceConfig = {
  id: 'mempool',
  label: 'Mempool.space',
  assetClass: 'CRYPTO',
  ttl: 300,
  fetch: fetchFees,
}
