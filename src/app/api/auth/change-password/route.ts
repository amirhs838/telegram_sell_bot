import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { SESSION_COOKIE, hashPassword, verifyPassword } from '@/lib/auth'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'رمز جدید باید حداقل ۸ کاراکتر باشد'),
})

export const POST = route(async (req: NextRequest) => {
  const authUser = await requireAuth()
  const body = changePasswordSchema.parse(await readJson(req))

  const user = await db.user.findUnique({ where: { id: authUser.id } })
  if (!user) throw new ApiError(401, 'unauthorized')

  const valid = await verifyPassword(body.currentPassword, user.passwordHash)
  if (!valid) throw new ApiError(400, 'رمز فعلی اشتباه است')

  const passwordHash = await hashPassword(body.newPassword)
  await db.user.update({ where: { id: user.id }, data: { passwordHash } })

  // Invalidate every other session of this user; keep the current one alive.
  const store = await cookies()
  const currentToken = store.get(SESSION_COOKIE)?.value
  await db.session.deleteMany({
    where: {
      userId: user.id,
      ...(currentToken ? { token: { not: currentToken } } : {}),
    },
  })

  await logEvent('auth.password_changed', 'رمز عبور تغییر یافت', { userId: user.id })
  return ok({ ok: true })
})
