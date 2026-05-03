import type { Context } from 'hono'
import type { ErrorCode } from '../types.js'

export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  return c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status)
}
