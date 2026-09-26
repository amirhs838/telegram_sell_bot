import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { notifyCustomer } from '@/lib/telegram'
import { orderStatusFa } from '@/lib/telegram-render'
import { ORDER_STATUSES, serializeOrder } from '../shared'

const FULL_INCLUDE = {
  customer: true,
  items: true,
} satisfies Prisma.OrderInclude

const patchSchema = z.object({
  status: z.enum(ORDER_STATUSES),
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

    return ok({ order })
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

    // No-op: nothing to change.
    if (body.status === existing.status) {
      return ok({ order: existing })
    }

    if (body.status === 'cancelled' && existing.status !== 'cancelled') {
      // Restock every tracked item and flip out-of-stock products back to active,
      // then persist the status change — all inside one transaction.
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
        await tx.order.update({ where: { id: existing.id }, data: { status: body.status } })
      })
    } else {
      await db.order.update({
        where: { id: existing.id },
        data: { status: body.status },
      })
    }

    const { label, emoji } = orderStatusFa(body.status)
    await logEvent(
      'order.status_changed',
      `سفارش #${existing.orderNumber} به «${label}» تغییر یافت`,
      { orderId: existing.id, from: existing.status, to: body.status },
    )

    // Best-effort customer notification over Telegram.
    const updated = await db.order.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    })
    const tgUserId = updated?.customer?.telegramUserId
    if (updated && tgUserId) {
      const text =
        body.status === 'cancelled'
          ? `🔴 سفارش #${existing.orderNumber} شما لغو شد.`
          : `وضعیت سفارش #${existing.orderNumber}: ${emoji} ${label}`
      notifyCustomer(tgUserId, text).catch(() => undefined)
    }

    return ok({ order: updated ? serializeOrder(updated) : null })
  },
)
