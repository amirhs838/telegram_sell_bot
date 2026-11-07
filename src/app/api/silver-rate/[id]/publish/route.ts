import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { publishSilverRate } from '@/lib/rate-publisher'
import { serializeRate } from '../../shared'

// ─── Manual retry of the daily silver-rate channel post ──────────────────────
// Idempotent: re-publishing a rate that is already published EDITS the same
// channel message — it never creates a duplicate post (Master prompt §14.7).

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const rate = await db.silverRate.findUnique({ where: { id } })
    if (!rate) throw new ApiError(404, 'نرخ نقره یافت نشد')

    const result = await publishSilverRate(id)

    const refreshed = await db.silverRate.findUnique({ where: { id } })
    if (!refreshed) throw new ApiError(404, 'نرخ نقره یافت نشد')

    return ok({ rate: serializeRate(refreshed), result })
  },
)
