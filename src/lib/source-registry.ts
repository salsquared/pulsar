import type { SourceConfig } from '../types.js'
import { coingecko } from '../ingest/sources/coingecko.js'

export const SOURCES: Record<string, SourceConfig> = {
  coingecko,
}

export function getSource(id: string): SourceConfig {
  const source = SOURCES[id]
  if (!source) throw new Error(`Unknown source: "${id}"`)
  return source
}
