import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { serializeRate } from '../shared'

const patchSchema = z.object({
  active: z.boolean().optional(),
  note: z.string().trim().max(300, 'توضیحات حداکثر ۳۰۰ کاراکتر است').nullish(),
})

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.silverRate.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'رکورد نرخ نقره یافت نشد')

    const body = patchSchema.parse(await readJson(req))

    const data: { active?: boolean; note?: string | null } = {}
    if (body.active !== undefined) data.active = body.active
    if (body.note !== undefined) data.note = body.note

    const rate = await db.silverRate.update({ where: { id }, data })

    return ok({ rate: serializeRate(rate) })
  },
)
