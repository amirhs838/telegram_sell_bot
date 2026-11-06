import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAdmin, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'

// GET /api/silver-rate — current active rate + history (panel display + AI tool)
export const GET = route(async () => {
  await requireAuth()
  const [current, history] = await Promise.all([
    db.silverRate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } }),
    db.silverRate.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  return ok({ current, history })
})

const createSchema = z.object({
  pricePerGram: z.number().positive('نرخ باید عددی بزرگ‌تر از صفر باشد'),
  unit: z.string().trim().max(30).optional(),
  note: z.string().trim().max(300).optional(),
})

// POST /api/silver-rate — manual entry by the admin (reference info ONLY).
// Changing the rate never recalculates product prices — the seller prices
// every product manually.
export const POST = route(async (req: NextRequest) => {
  const admin = await requireAdmin()
  const body = createSchema.parse(await readJson(req))

  const created = await db.$transaction(async (tx) => {
    await tx.silverRate.updateMany({ where: { active: true }, data: { active: false } })
    return tx.silverRate.create({
      data: {
        pricePerGram: body.pricePerGram,
        unit: body.unit?.trim() || 'تومان/گرم',
        note: body.note?.trim() || null,
        active: true,
        createdByEmail: admin.email,
      },
    })
  })

  await logEvent('silver_rate.updated', `نرخ نقره ثبت شد: ${created.pricePerGram.toLocaleString('fa-IR')} ${created.unit}`, {
    rateId: created.id,
    pricePerGram: created.pricePerGram,
    by: admin.email,
  })

  return ok({ rate: created }, 201)
})
