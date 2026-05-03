import type { SourceConfig } from '../types.js'
import { coingecko } from '../ingest/sources/coingecko.js'
import { mempool } from '../ingest/sources/mempool.js'
import { yahoo } from '../ingest/sources/yahoo.js'
import { exchangerate } from '../ingest/sources/exchangerate.js'
import { fred } from '../ingest/sources/fred.js'

export const SOURCES: Record<string, SourceConfig> = {
  coingecko,
  mempool,
  yahoo,
  exchangerate,
  fred,
}

export function getSource(id: string): SourceConfig {
  const source = SOURCES[id]
  if (!source) throw new Error(`Unknown source: "${id}"`)
  return source
}
