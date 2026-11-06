import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { serializeDestination } from './shared'

// ─── Bank card destinations shown to customers for card-to-card payment ──────

export const GET = route(async () => {
  await requireAuth()

  const destinations = await db.paymentDestination.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  return ok({ destinations: destinations.map(serializeDestination) })
})

const baseFields = {
  bankName: z.string().trim().min(1, 'نام بانک الزامی است').max(100),
  accountHolder: z.string().trim().min(1, 'نام صاحب حساب الزامی است').max(150),
  cardNumber: z
    .string()
    .trim()
    .min(10, 'شماره کارت باید حداقل ۱۰ کاراکتر باشد')
    .max(26, 'شماره کارت حداکثر ۲۶ کاراکتر است'),
  sheba: z.string().trim().max(34, 'شماره شبا حداکثر ۳۴ کاراکتر است').nullish(),
  accountNumber: z.string().trim().max(30, 'شماره حساب حداکثر ۳۰ کاراکتر است').nullish(),
  note: z.string().trim().max(500, 'توضیحات حداکثر ۵۰۰ کاراکتر است').nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}

const createSchema = z.object(baseFields)

export const POST = route(async (req: NextRequest) => {
  await requireAuth()
  const body = createSchema.parse(await readJson(req))

  const destination = await db.paymentDestination.create({
    data: {
      bankName: body.bankName,
      accountHolder: body.accountHolder,
      cardNumber: body.cardNumber,
      sheba: body.sheba ?? null,
      accountNumber: body.accountNumber ?? null,
      note: body.note ?? null,
      active: body.active ?? true,
      sortOrder: body.sortOrder ?? 0,
    },
  })

  await logEvent(
    'payment_destination.saved',
    `مقصد پرداخت «${destination.bankName}» ذخیره شد`,
    { destinationId: destination.id },
  )

  return ok({ destination: serializeDestination(destination) }, 201)
})
