import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { serializeDestination } from '../shared'

const patchSchema = z.object({
  bankName: z.string().trim().min(1, 'نام بانک الزامی است').max(100).optional(),
  accountHolder: z.string().trim().min(1, 'نام صاحب حساب الزامی است').max(150).optional(),
  cardNumber: z
    .string()
    .trim()
    .min(10, 'شماره کارت باید حداقل ۱۰ کاراکتر باشد')
    .max(26, 'شماره کارت حداکثر ۲۶ کاراکتر است')
    .optional(),
  sheba: z.string().trim().max(34, 'شماره شبا حداکثر ۳۴ کاراکتر است').nullish(),
  accountNumber: z.string().trim().max(30, 'شماره حساب حداکثر ۳۰ کاراکتر است').nullish(),
  note: z.string().trim().max(500, 'توضیحات حداکثر ۵۰۰ کاراکتر است').nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.paymentDestination.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'مقصد پرداخت یافت نشد')

    const body = patchSchema.parse(await readJson(req))

    const data: Partial<{
      bankName: string
      accountHolder: string
      cardNumber: string
      sheba: string | null
      accountNumber: string | null
      note: string | null
      active: boolean
      sortOrder: number
    }> = {}
    if (body.bankName !== undefined) data.bankName = body.bankName
    if (body.accountHolder !== undefined) data.accountHolder = body.accountHolder
    if (body.cardNumber !== undefined) data.cardNumber = body.cardNumber
    if (body.sheba !== undefined) data.sheba = body.sheba ?? null
    if (body.accountNumber !== undefined) data.accountNumber = body.accountNumber ?? null
    if (body.note !== undefined) data.note = body.note ?? null
    if (body.active !== undefined) data.active = body.active
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder

    const destination = await db.paymentDestination.update({ where: { id }, data })

    await logEvent(
      'payment_destination.saved',
      `مقصد پرداخت «${destination.bankName}» به‌روزرسانی شد`,
      { destinationId: destination.id },
    )

    return ok({ destination: serializeDestination(destination) })
  },
)

export const DELETE = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.paymentDestination.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'مقصد پرداخت یافت نشد')

    await db.paymentDestination.delete({ where: { id } })

    await logEvent(
      'payment_destination.deleted',
      `مقصد پرداخت «${existing.bankName}» حذف شد`,
      { destinationId: existing.id },
    )

    return ok({ ok: true })
  },
)
