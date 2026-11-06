import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { notifyCustomer } from '@/lib/telegram'
import { orderStatusFa } from '@/lib/telegram-render'
import { ORDER_INCLUDE, ORDER_STATUSES, serializeOrder } from '../shared'

const FULL_INCLUDE = {
  customer: true,
  items: true,
  payments: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
  },
} satisfies Prisma.OrderInclude

const patchSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  // کد رهگیری پستی — optional, null clears.
  trackingCode: z.string().trim().max(100, 'کد رهگیری حداکثر ۱۰۰ کاراکتر است').nullish(),
})

export const GET = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const order = await db.order.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    })
    if (!order) throw new ApiError(404, 'سفارش یافت نشد')

    return ok({ order: serializeOrder(order) })
  },
)

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.order.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    })
    if (!existing) throw new ApiError(404, 'سفارش یافت نشد')

    const body = patchSchema.parse(await readJson(req))

    const statusChange = body.status !== undefined && body.status !== existing.status
    const trackingChange =
      body.trackingCode !== undefined &&
      body.trackingCode !== (existing.trackingCode ?? null)

    // No-op: nothing to change.
    if (!statusChange && !trackingChange) {
      return ok({ order: serializeOrder(existing) })
    }

    const data: { status?: string; trackingCode?: string | null } = {}
    if (statusChange) data.status = body.status
    if (trackingChange) data.trackingCode = body.trackingCode ?? null

    if (statusChange && body.status === 'cancelled' && existing.status !== 'cancelled') {
      // Restock every tracked item and flip out-of-stock products back to active,
      // then persist the status change (+ optional tracking code) — one transaction.
      await db.$transaction(async (tx) => {
        for (const item of existing.items) {
          if (!item.productId) continue
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            select: { id: true, status: true },
          })
          if (!product) continue
          await tx.product.update({
            where: { id: product.id },
            data: {
              stock: { increment: item.quantity },
              ...(product.status === 'out_of_stock' ? { status: 'active' } : {}),
            },
          })
        }
        await tx.order.update({ where: { id: existing.id }, data })
      })
    } else {
      await db.order.update({
        where: { id: existing.id },
        data,
      })
    }

    const updated = await db.order.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    })
    const tgUserId = updated?.customer?.telegramUserId

    // Tracking code saved — Persian message + ActivityLog.
    if (trackingChange) {
      await logEvent(
        'order.tracking_set',
        body.trackingCode
          ? `کد رهگیری سفارش #${existing.orderNumber} ثبت شد: ${body.trackingCode}`
          : `کد رهگیری سفارش #${existing.orderNumber} حذف شد`,
        { orderId: existing.id, trackingCode: body.trackingCode ?? null },
      )
      if (updated && tgUserId && body.trackingCode) {
        notifyCustomer(
          tgUserId,
          [
            `📦 سفارش #${existing.orderNumber} شما برای ارسال آماده شد.`,
            `🔎 کد رهگیری پستی: ${body.trackingCode}`,
            'می‌توانید وضعیت مرسوله را از سایت posta.ir پیگیری کنید.',
          ].join('\n'),
        ).catch(() => undefined)
      }
    }

    // Status change — existing log + best-effort customer notification.
    if (statusChange && body.status) {
      const { label, emoji } = orderStatusFa(body.status)
      await logEvent(
        'order.status_changed',
        `سفارش #${existing.orderNumber} به «${label}» تغییر یافت`,
        { orderId: existing.id, from: existing.status, to: body.status },
      )

      if (updated && tgUserId) {
        const text =
          body.status === 'cancelled'
            ? `🔴 سفارش #${existing.orderNumber} شما لغو شد.`
            : `وضعیت سفارش #${existing.orderNumber}: ${emoji} ${label}`
        notifyCustomer(tgUserId, text).catch(() => undefined)
      }
    }

    return ok({ order: updated ? serializeOrder(updated) : null })
  },
)
