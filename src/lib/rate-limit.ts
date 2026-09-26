// Simple in-memory sliding-window rate limiter (MVP: single process).
type Bucket = { hits: number[] }

const buckets = new Map<string, Bucket>()

// periodic cleanup to avoid unbounded growth
let lastSweep = Date.now()
function sweep() {
  const now = Date.now()
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < 10 * 60_000)
    if (bucket.hits.length === 0) buckets.delete(key)
  }
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  sweep()
  const now = Date.now()
  const bucket = buckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)
  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0]
    buckets.set(key, bucket)
    return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - oldest)) / 1000) }
  }
  bucket.hits.push(now)
  buckets.set(key, bucket)
  return { allowed: true, retryAfterSec: 0 }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'local'
}
