import { ok, requireAuth, route } from '@/lib/api'

const BOT_SERVICE_URL = 'http://127.0.0.1:3002/health'

export const GET = route(async () => {
  await requireAuth()

  try {
    const res = await fetch(BOT_SERVICE_URL, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (!res.ok) {
      return ok({ ok: false, error: 'سرویس ربات در دسترس نیست' })
    }
    const json = await res.json()
    return ok(json)
  } catch {
    // Bot service down / timeout — never throw, always a 200 with ok flag.
    return ok({ ok: false, error: 'سرویس ربات در دسترس نیست' })
  }
})
