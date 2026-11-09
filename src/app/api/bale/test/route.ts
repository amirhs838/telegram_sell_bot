import { ok, requireAuth, route } from '@/lib/api'
import { probeBaleConnection } from '@/lib/bale'

export const POST = route(async () => {
  await requireAuth()
  return ok(await probeBaleConnection())
})
