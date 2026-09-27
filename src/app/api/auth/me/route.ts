import { ok, requireAuth, route } from '@/lib/api'

export const GET = route(async () => {
  const user = await requireAuth()
  return ok({ user })
})
