import type { Prisma } from '@prisma/client'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'

export const PAYMENT_STATUSES = [
  'awaiting_payment',
  'payment_review',
  'paid',
  'rejected',
  'refund_pending',
  'refunded',
] as const

export const PAYMENT_INCLUDE = {
  order: {
    include: {
      customer: { select: { id: true, firstName: true, telegramUsername: true } },
      items: true,
    },
  },
  events: { orderBy: { createdAt: 'desc' as const }, take: 10 },
} satisfies Prisma.PaymentInclude

export function serializePayment(p: Prisma.PaymentGetPayload<typeof PAYMENT_INCLUDE>) {
  return {
    id: p.id,
    orderId: p.orderId,
    status: p.status,
    amountSnapshot: p.amountSnapshot,
    receiptImage: p.receiptImage,
    payerName: p.payerName,
    trackingNumber: p.trackingNumber,
    customerNote: p.customerNote,
    reviewedByEmail: p.reviewedByEmail,
    reviewedAt: p.reviewedAt,
    rejectReason: p.rejectReason,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    order: {
      id: p.order.id,
      orderNumber: p.order.orderNumber,
      status: p.order.status,
      total: p.order.total,
      customerName: p.order.customerName,
      customer: p.order.customer,
      items: p.order.items.map((i) => ({
        productNameSnapshot: i.productNameSnapshot,
        quantity: i.quantity,
        total: i.total,
      })),
    },
    events: p.events.map((e) => ({
      id: e.id,
      type: e.type,
      actorEmail: e.actorEmail,
      note: e.note,
      createdAt: e.createdAt,
    })),
  }
}

// GET /api/payments?status=payment_review — manual payment review queue
export const GET = route(async (req) => {
  await requireAuth()
  const sp = req.nextUrl?.searchParams ?? new URL(req.url).searchParams
  const status = sp.get('status')?.trim()

  const where =
    status && (PAYMENT_STATUSES as readonly string[]).includes(status)
      ? { status }
      : undefined

  const payments = await db.payment.findMany({
    where,
    include: PAYMENT_INCLUDE,
    orderBy: { updatedAt: 'desc' },
    take: 100,
  })

  const [reviewCount, paidCount, awaitingCount] = await Promise.all([
    db.payment.count({ where: { status: 'payment_review' } }),
    db.payment.count({ where: { status: 'paid' } }),
    db.payment.count({ where: { status: 'awaiting_payment' } }),
  ])

  return ok({
    payments: payments.map(serializePayment),
    stats: { reviewCount, paidCount, awaitingCount },
  })
})
