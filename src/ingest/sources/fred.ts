// FRED (Federal Reserve Economic Data) macro series fetcher.
// Produces NormalizedMacro rows, not NormalizedTick — pipeline branches on fetchMacro.
// Observations with value "." (FRED's missing-data sentinel) are filtered out.
// History is fetched from 2015-01-01; INSERT OR IGNORE handles deduplication on
// subsequent daily runs when FRED publishes new observations.

import type { NormalizedMacro, SourceConfig } from '../../types.js'

const FRED_SERIES = [
  { id: 'FEDFUNDS', name: 'Federal Funds Effective Rate' },
  { id: 'CPIAUCSL', name: 'Consumer Price Index (All Urban Consumers)' },
  { id: 'UNRATE',   name: 'Unemployment Rate' },
  { id: 'GDP',      name: 'Gross Domestic Product' },
  { id: 'DGS10',    name: '10-Year Treasury Constant Maturity Rate' },
  { id: 'DGS2',     name: '2-Year Treasury Constant Maturity Rate' },
  { id: 'M2SL',     name: 'M2 Money Supply' },
]

type FredObservation = { date: string; value: string }

async function fetchSeries(
  seriesId: string,
  apiKey: string,
): Promise<FredObservation[]> {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations')
  url.searchParams.set('series_id', seriesId)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('observation_start', '2015-01-01')
  url.searchParams.set('limit', '10000')
  url.searchParams.set('sort_order', 'asc')

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`FRED request failed for ${seriesId}: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as { observations: FredObservation[] }
  return data.observations
}

async function fetchMacro(): Promise<NormalizedMacro[]> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY is not set')

  const results: NormalizedMacro[] = []

  for (const series of FRED_SERIES) {
    const observations = await fetchSeries(series.id, apiKey)
    for (const obs of observations) {
      if (obs.value === '.') continue  // FRED missing-data sentinel
      const value = parseFloat(obs.value)
      if (isNaN(value)) continue
      results.push({
        seriesId: series.id,
        name: series.name,
        value,
        timestamp: new Date(obs.date + 'T00:00:00Z'),
        source: 'fred',
      })
    }
  }

  return results
}

export const fred: SourceConfig = {
  id: 'fred',
  label: 'FRED (St. Louis Fed)',
  assetClass: 'MACRO',
  ttl: 86400,
  fetchMacro,
}
