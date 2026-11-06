import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { notifyCustomer } from '@/lib/telegram'
import { serializePayment } from '../../shared'

// ─── Approve a manual card-to-card payment (human decision, idempotent) ──────
// Stock is NEVER touched here — it was already decremented at order creation.

const approveSchema = z.object({
  reviewNote: z.string().trim().max(500, 'یادداشت حداکثر ۵۰۰ کاراکتر است').optional(),
})

const PAYMENT_INCLUDE = {
  order: {
    include: {
      items: true,
      customer: { select: { id: true, telegramUserId: true, firstName: true } },
    },
  },
} satisfies Prisma.PaymentInclude

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    const user = await requireAuth()
    const { id } = await params

    const existing = await db.payment.findUnique({
      where: { id },
      include: PAYMENT_INCLUDE,
    })
    if (!existing) throw new ApiError(404, 'پرداخت یافت نشد')

    // Idempotent: approving an already-approved payment has no side effects.
    if (existing.status === 'approved') {
      return ok({ payment: serializePayment(existing, existing.order), alreadyApproved: true })
    }

    const body = approveSchema.parse(await readJson(req).catch(() => ({})))

    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: 'approved',
          reviewedBy: user.id,
          reviewedByName: user.name,
          reviewedAt: new Date(),
          ...(body.reviewNote !== undefined ? { reviewNote: body.reviewNote } : {}),
        },
      })
      await tx.order.update({
        where: { id: existing.orderId },
        data: {
          paymentStatus: 'paid',
          // A pending order becomes confirmed as soon as its payment is approved.
          ...(existing.order.status === 'pending' ? { status: 'confirmed' } : {}),
        },
      })
    })

    await logEvent(
      'payment.approved',
      `پرداخت سفارش #${existing.order.orderNumber} توسط ${user.name} تأیید شد`,
      {
        paymentId: existing.id,
        orderId: existing.orderId,
        orderNumber: existing.order.orderNumber,
        reviewedBy: user.id,
        reviewedAt: new Date().toISOString(),
      },
    )

    // Best-effort customer notification — never blocks the response.
    const tgUserId = existing.order.customer?.telegramUserId
    if (tgUserId) {
      notifyCustomer(
        tgUserId,
        [
          `✅ پرداخت سفارش #${existing.order.orderNumber} شما تأیید شد.`,
          '🔄 فرایند آماده‌سازی و ارسال سفارش شما آغاز می‌شود؛ به‌زودی از طریق همین ربات در جریان قرار می‌گیرید.',
          '🙏 از اعتماد شما سپاسگزاریم.',
        ].join('\n'),
      ).catch(() => undefined)
    }

    const updated = await db.payment.findUnique({
      where: { id: existing.id },
      include: PAYMENT_INCLUDE,
    })
    if (!updated) throw new ApiError(404, 'پرداخت یافت نشد')

    return ok({ payment: serializePayment(updated, updated.order) })
  },
)
