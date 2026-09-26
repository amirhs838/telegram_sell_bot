import { db } from '@/lib/db'

export type LogLevel = 'info' | 'warn' | 'error'

const SENSITIVE_KEYS = /password|token|secret|apikey|api_key|authorization|cookie/i

function redact(data: unknown, depth = 0): unknown {
  if (depth > 4 || data === null || data === undefined) return data
  if (Array.isArray(data)) return data.slice(0, 50).map((v) => redact(v, depth + 1))
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  if (typeof data === 'string' && data.length > 2000) return data.slice(0, 2000) + '…'
  return data
}

/**
 * Structured log: one JSON line to stdout + a row in ActivityLog.
 * Never log passwords/tokens/api keys — they are redacted automatically.
 */
export async function logEvent(
  type: string,
  message: string,
  data?: unknown,
  level: LogLevel = 'info',
) {
  const safe = data === undefined ? undefined : (redact(data) as Record<string, unknown>)
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level, type, message, data: safe }),
  )
  try {
    await db.activityLog.create({
      data: {
        level,
        type,
        message,
        data: safe === undefined ? null : JSON.stringify(safe),
      },
    })
  } catch (e) {
    console.error('[logger] failed to persist activity log', e)
  }
}
