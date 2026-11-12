// Admin-only self-service Gemini key manager (owner request: «خودم کلید را در
// پنل عوض کنم»). Returns the CONFIGURED keys as masked fingerprints plus their
// live image-tier state (ready / quota-parked until HH:MM Tehran / rejected).
// The full key values never leave the server.
import { ok, requireAuth, route } from '@/lib/api'
import { geminiImageKeyStatuses } from '@/lib/ai/provider'

function tehranClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      timeZone: 'Asia/Tehran',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms))
  } catch {
    return ''
  }
}

export const dynamic = 'force-dynamic'

export const GET = route(async () => {
  await requireAuth()
  const now = Date.now()
  const statuses = await geminiImageKeyStatuses()
  return ok({
    count: statuses.length,
    readyCount: statuses.filter((k) => !k.parkedUntil).length,
    keys: statuses.map((k) => ({
      fingerprint: k.fingerprint,
      source: k.source,
      parked: k.parkedUntil !== null,
      parkKind: k.parkKind,
      parkedUntilTehran: k.parkedUntil ? tehranClock(k.parkedUntil) : null,
    })),
  })
})
