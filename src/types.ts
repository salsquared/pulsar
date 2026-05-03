// ─── Prisma enum mirrors ──────────────────────────────────────────────────────

export type AssetClass = 'CRYPTO' | 'EQUITY' | 'FOREX' | 'COMMODITY' | 'MACRO'
export type JobStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface AssetSummary {
  id: string
  symbol: string
  name: string
  assetClass: AssetClass
  source: string
  active: boolean
}

export interface Tick {
  timestamp: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
  source: string
}

export interface PricePoint {
  assetId: string
  symbol: string
  name: string
  assetClass: AssetClass
  close: number
  change24h: number | null
  volume: number | null
  source: string
  timestamp: string
}

export interface OhlcvPoint {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number | null
}

// ─── Ingest types ─────────────────────────────────────────────────────────────

export interface NormalizedTick {
  assetId: string
  timestamp: Date
  close: number
  open?: number | null
  high?: number | null
  low?: number | null
  volume?: number | null
  // Optional asset metadata. Auto-registering sources (CRYPTO) can carry
  // human-readable names/symbols here so the pipeline writes them to Asset.
  name?: string
  symbol?: string
}

export interface NormalizedMacro {
  seriesId: string
  name: string
  value: number
  timestamp: Date
  source: string
}

export interface SourceConfig {
  id: string
  label: string
  assetClass: AssetClass
  ttl: number
  fetch?: () => Promise<NormalizedTick[]>
  fetchHistory?: (assetId: string, from: Date, to: Date) => Promise<NormalizedTick[]>
  fetchMacro?: () => Promise<NormalizedMacro[]>
}

// ─── WebSocket protocol ───────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'subscribe'; assetIds: string[] }
  | { type: 'unsubscribe'; assetIds: string[] }

export type ServerMessage =
  | { type: 'welcome'; sessionId: string; serverTime: string }
  | { type: 'subscribed'; assetIds: string[] }
  | { type: 'tick'; assetId: string; tick: Tick }
  | { type: 'error'; code: string; message: string }

// ─── Internal API ─────────────────────────────────────────────────────────────

export interface IngestNotifyBody {
  sourceId: string
  ticks: Array<{
    assetId: string
    timestamp: string
    open: number | null
    high: number | null
    low: number | null
    close: number
    volume: number | null
  }>
}

// ─── Error handling ───────────────────────────────────────────────────────────

export type ErrorCode =
  | 'bad_request'
  | 'tick_retention_exceeded'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_error'
  | 'service_unavailable'
  | 'internal'

export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    details?: unknown
  }
}
