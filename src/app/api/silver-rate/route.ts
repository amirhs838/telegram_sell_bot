import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { publishSilverRate } from '@/lib/rate-publisher'
import { serializeRate } from './shared'

// ─── Manual silver rate (admin-entered; reference info ONLY) ─────────────────
// The silver rate never prices products automatically — the seller always sets
// the final price by hand. This endpoint keeps the reference history AND
// auto-publishes the daily rate post to the Telegram channel after saving.
// Rate persistence NEVER depends on Telegram success (Master prompt §14).

export const GET = route(async () => {
  await requireAuth()

  const [current, history] = await Promise.all([
    db.silverRate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } }),
    db.silverRate.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  ])

  return ok({
    current: current ? serializeRate(current) : null,
    history: history.map(serializeRate),
  })
})

const createSchema = z.object({
  ratePerGram: z
    .number()
    .positive('نرخ نقره باید عددی بزرگ‌تر از صفر باشد'),
  note: z.string().trim().max(300, 'توضیحات حداکثر ۳۰۰ کاراکتر است').optional(),
})

export const POST = route(async (req: NextRequest) => {
  const user = await requireAuth()
  const body = createSchema.parse(await readJson(req))

  // Every entry creates a NEW row — the rate history is preserved.
  const rate = await db.silverRate.create({
    data: {
      ratePerGram: body.ratePerGram,
      unit: 'تومان / گرم',
      note: body.note ?? null,
      active: true,
      createdBy: user.id,
      createdByName: user.name,
    },
  })

  await logEvent(
    'silver_rate.updated',
    `نرخ نقره به ${body.ratePerGram.toLocaleString('fa-IR')} تومان در گرم ثبت شد`,
    { rateId: rate.id, ratePerGram: body.ratePerGram },
  )

  // Auto-publish the daily rate post (best-effort — never blocks the save,
  // failures stay visible in the panel and can be retried).
  await publishSilverRate(rate.id).catch(() => undefined)

  const refreshed = await db.silverRate.findUnique({ where: { id: rate.id } })
  return ok({ rate: refreshed ? serializeRate(refreshed) : serializeRate(rate) }, 201)
})
