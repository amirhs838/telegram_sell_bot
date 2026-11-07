import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { PAYMENT_REVIEW_STATUSES, serializePayment } from './shared'

// ─── Manual card-to-card payments (admin review queue) ───────────────────────
// No automatic verification of any kind — a human always approves by hand.

export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')?.trim()
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(sp.get('pageSize') ?? '20', 10) || 20),
  )

  const where: Prisma.PaymentWhereInput = {}
  if (status && (PAYMENT_REVIEW_STATUSES as readonly string[]).includes(status)) {
    where.status = status
  }

  const include = {
    order: {
      select: {
        id: true,
        orderNumber: true,
        total: true,
        status: true,
        paymentStatus: true,
        customerName: true,
        phone: true,
        items: {
          select: { productNameSnapshot: true, quantity: true, unitPriceSnapshot: true },
          orderBy: { id: 'asc' as const },
        },
      },
    },
  } satisfies Prisma.PaymentInclude

  const [rows, total] = await Promise.all([
    db.payment.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.payment.count({ where }),
  ])

  return ok({ payments: rows.map((r) => serializePayment(r, r.order)), total, page, pageSize })
})
