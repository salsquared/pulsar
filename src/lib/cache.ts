import type { Context } from 'hono'

interface CacheEntry {
  value: unknown
  expiresAt: number
  stale: unknown
}

const store = new Map<string, CacheEntry>()

function sortedQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&')
}

function jsonResponse(value: unknown, xCache: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Cache': xCache },
  })
}

// fn() returns raw data (not a Response). withCache builds the Response so it
// can inject the X-Cache header before returning.
export async function withCache<T>(c: Context, ttlSec: number, fn: () => Promise<T>): Promise<Response> {
  const key = c.req.path + '?' + sortedQueryString(c.req.query())
  const now = Date.now()
  const entry = store.get(key)

  if (entry && entry.expiresAt > now) {
    return jsonResponse(entry.value, 'HIT')
  }

  try {
    const value = await fn()
    // If fn() returned a Response (e.g. apiError), pass it through without caching.
    if (value instanceof Response) return value
    store.set(key, { value, expiresAt: now + ttlSec * 1000, stale: value })
    return jsonResponse(value, 'MISS')
  } catch (err) {
    if (entry?.stale !== undefined) {
      store.set(key, { value: entry.stale, expiresAt: now + 60_000, stale: entry.stale })
      return jsonResponse(entry.stale, 'STALE-FALLBACK')
    }
    throw err
  }
}
