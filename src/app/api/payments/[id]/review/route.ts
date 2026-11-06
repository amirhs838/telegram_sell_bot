import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAdmin, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { sendMessage } from '@/lib/telegram'
import { formatMoney } from '@/lib/telegram-render'

type Ctx = { params: Promise<{ id: string }> }

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
})

/**
 * POST /api/payments/[id]/review — manual admin decision.
 *
 * Hard rules (per project charter):
 *  - approval is ALWAYS a human decision made in the panel
 *  - approving does NOT touch stock (stock was already reserved at order time)
 *  - idempotent-ish: approving an already-paid payment is a no-op (no double
 *    events, no double notifications); rejecting requires a reason
 */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const admin = await requireAdmin()
  const { id } = await params
  const body = reviewSchema.parse(await readJson(req))

  const payment = await db.payment.findUnique({
    where: { id },
    include: { order: { include: { customer: true } } },
  })
  if (!payment) throw new ApiError(404, 'پرداخت یافت نشد')

  const orderNumber = payment.order.orderNumber
  const customerTgId = payment.order.customer.telegramUserId

  // ── Approve ────────────────────────────────────────────────────────────────
  if (body.action === 'approve') {
    if (payment.status === 'paid') {
      // double-click protection — nothing left to do
      return ok({ ok: true, alreadyDone: true, status: 'paid' })
    }
    if (payment.status !== 'payment_review') {
      throw new ApiError(400, 'برای تأیید، ابتدا باید رسید پرداخت ثبت شده باشد')
    }

    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: {
          status: 'paid',
          reviewedByEmail: admin.email,
          reviewedAt: new Date(),
          rejectReason: null,
          events: { create: { type: 'approved', actorEmail: admin.email } },
        },
      })
      // order moves forward only from pending; never regresses
      if (payment.order.status === 'pending') {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: 'confirmed' } })
      }
      await tx.activityLog.create({
        data: {
          level: 'info',
          type: 'payment.approved',
          message: `پرداخت سفارش #${orderNumber} توسط ${admin.email} تأیید شد`,
          data: JSON.stringify({ paymentId: id, orderId: payment.orderId, by: admin.email }),
        },
      })
    })

    // customer notification (best-effort)
    if (customerTgId) {
      sendMessage(
        customerTgId,
        `✅ پرداخت سفارش #${orderNumber} تأیید شد (${formatMoney(payment.amountSnapshot)}).\n\nسفارش شما وارد مرحله پردازش می‌شود. 🙏`,
      ).catch(() => undefined)
    }
    return ok({ ok: true, status: 'paid' })
  }

  // ── Reject ─────────────────────────────────────────────────────────────────
  if (!body.reason || body.reason.length < 3) {
    throw new ApiError(400, 'دلیل رد پرداخت الزامی است')
  }
  if (payment.status === 'rejected' && payment.rejectReason === body.reason) {
    return ok({ ok: true, alreadyDone: true, status: 'rejected' })
  }
  if (payment.status !== 'payment_review') {
    throw new ApiError(400, 'رد پرداخت فقط زمانی ممکن است که رسیدی در انتظار بررسی باشد')
  }

  await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectReason: body.reason!.trim(),
        reviewedByEmail: admin.email,
        reviewedAt: new Date(),
        events: {
          create: { type: 'rejected', actorEmail: admin.email, note: body.reason!.trim() },
        },
      },
    })
    await tx.activityLog.create({
      data: {
        level: 'warn',
        type: 'payment.rejected',
        message: `پرداخت سفارش #${orderNumber} توسط ${admin.email} رد شد`,
        data: JSON.stringify({ paymentId: id, orderId: payment.orderId, by: admin.email, reason: body.reason }),
      },
    })
  })

  if (customerTgId) {
    sendMessage(
      customerTgId,
      `🔴 پرداخت سفارش #${orderNumber} تأیید نشد.\n\nدلیل: ${body.reason!.trim()}\n\nدر صورت نیاز، رسید اصلاح‌شده را از بخش «سفارش‌های من» ارسال کنید.`,
    ).catch(() => undefined)
  }
  return ok({ ok: true, status: 'rejected' })
})
