import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { notifyCustomer } from '@/lib/telegram'
import { serializePayment } from '../../shared'

// ─── Reject a manual card-to-card payment (reason REQUIRED) ──────────────────
// The order is never auto-cancelled or expired — the customer may resubmit a
// corrected receipt in the bot at any time.

const rejectSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'دلیل رد پرداخت الزامی است (حداقل ۳ کاراکتر)')
    .max(1000, 'دلیل رد پرداخت حداکثر ۱۰۰۰ کاراکتر است'),
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

    // Idempotent: rejecting an already-rejected payment has no side effects.
    if (existing.status === 'rejected') {
      return ok({ payment: serializePayment(existing, existing.order), alreadyRejected: true })
    }
    if (existing.status === 'approved') {
      throw new ApiError(409, 'این پرداخت قبلاً تأیید شده است')
    }

    const body = rejectSchema.parse(await readJson(req))

    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: 'rejected',
          reviewNote: body.reason,
          reviewedBy: user.id,
          reviewedByName: user.name,
          reviewedAt: new Date(),
        },
      })
      await tx.order.update({
        where: { id: existing.orderId },
        data: { paymentStatus: 'rejected' },
      })
    })

    await logEvent(
      'payment.rejected',
      `پرداخت سفارش #${existing.order.orderNumber} توسط ${user.name} رد شد — دلیل: ${body.reason}`,
      {
        paymentId: existing.id,
        orderId: existing.orderId,
        orderNumber: existing.order.orderNumber,
        reason: body.reason,
        reviewedBy: user.id,
        reviewedAt: new Date().toISOString(),
      },
    )

    // Best-effort customer notification with the rejection reason and guidance.
    const tgUserId = existing.order.customer?.telegramUserId
    if (tgUserId) {
      notifyCustomer(
        tgUserId,
        [
          `❌ پرداخت سفارش #${existing.order.orderNumber} شما تأیید نشد.`,
          `📝 دلیل: ${body.reason}`,
          'لطفاً پس از بررسی، رسید اصلاح‌شده را مجدداً از طریق ربات ارسال کنید. سفارش شما همچنان فعال است و منتظر رسید جدید می‌ماند.',
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
