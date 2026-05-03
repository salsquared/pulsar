import type { Context, Next } from 'hono'
import { apiError } from './errors.js'

export function internalTokenMiddleware() {
  return async (c: Context, next: Next) => {
    const token = process.env.PULSAR_INTERNAL_TOKEN
    const auth = c.req.header('Authorization')
    const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : null

    if (!token || !provided || !timingSafeEqual(token, provided)) {
      return apiError(c, 401, 'unauthorized', 'invalid or missing token')
    }

    await next()
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
