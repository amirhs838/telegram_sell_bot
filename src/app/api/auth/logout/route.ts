import { ok, requireAuth, route } from '@/lib/api'
import { destroySession } from '@/lib/auth'

export const POST = route(async () => {
  await requireAuth()
  await destroySession()
  return ok({ ok: true })
})
