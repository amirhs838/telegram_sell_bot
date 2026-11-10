import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { getBaleStatus } from '@/lib/bale'

const RECENT_TYPES = [
  'bale_out',
  'bale_error',
  'bale.publish',
  'bale.sync',
  'bale.test',
  'bale.config_updated',
  'bale.config_removed',
]

export const GET = route(async () => {
  await requireAuth()

  const recent = await db.activityLog.findMany({
    where: { type: { in: RECENT_TYPES } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true, type: true, message: true, createdAt: true },
  })

  return ok({ ...(await getBaleStatus()), recentMessages: recent })
})
