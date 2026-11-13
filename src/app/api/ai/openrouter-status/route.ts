// Admin-only self-service OpenRouter status (owner request: «خودم کلید و مدل را
// در پنل عوض کنم»). Returns the masked key fingerprint, its live image-pipeline
// state (ready / parked for quota-auth-credits-model until HH:MM Tehran) and a
// best-effort credit balance lookup. The full key value never leaves the server.
import { ok, requireAuth, route } from '@/lib/api'
import { openRouterKeyStatus, openRouterAccountInfo } from '@/lib/ai/provider'

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
  const status = await openRouterKeyStatus()
  const account = status.keyConfigured ? await openRouterAccountInfo() : null
  return ok({
    ...status,
    ready: status.keyConfigured && !status.parkedUntil,
    parkedUntilTehran: status.parkedUntil ? tehranClock(status.parkedUntil) : null,
    account,
  })
})
