import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { getTelegramStatus } from '@/lib/telegram'

const RECENT_TYPES = [
  'telegram_out',
  'telegram_error',
  'telegram.publish',
  'telegram.sync',
  'telegram.unpublish',
  'telegram.test',
  'telegram.config_updated',
  'telegram.config_removed',
]

export const GET = route(async () => {
  await requireAuth()

  const recent = await db.activityLog.findMany({
    where: { type: { in: RECENT_TYPES } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true, type: true, message: true, createdAt: true },
  })

  return ok({ ...(await getTelegramStatus()), recentMessages: recent })
})
