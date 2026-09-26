import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, route } from '@/lib/api'
import { createSession, verifyPassword } from '@/lib/auth'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { clientIp, rateLimit } from '@/lib/rate-limit'

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
})

// Dummy bcrypt hash used to equalize timing when the email does not exist.
const DUMMY_HASH = '$2a$10$C6UzMDM.H6dfI/f/IKcEeO7VTgxjrpU8k95Lxvtqk1PGCvXnLBDF6'

export const POST = route(async (req: NextRequest) => {
  const { allowed } = rateLimit(`login:${clientIp(req)}`, 5, 60_000)
  if (!allowed) {
    throw new ApiError(429, 'تلاش‌های ورود بیش از حد مجاز است. لطفاً یک دقیقه دیگر دوباره امتحان کنید.')
  }

  const body = loginSchema.parse(await readJson(req))
  const email = body.email.trim().toLowerCase()

  const user = await db.user.findUnique({ where: { email } })
  const valid = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH)

  if (!user || !valid) {
    await logEvent('auth.failed', 'تلاش ناموفق برای ورود', { email }, 'warn')
    throw new ApiError(401, 'ایمیل یا رمز عبور اشتباه است')
  }

  await createSession(user.id)
  return ok({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})
