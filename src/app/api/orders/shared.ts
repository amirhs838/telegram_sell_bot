import type { Order, OrderItem, Payment } from '@prisma/client'
import type { Prisma } from '@prisma/client'

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'completed',
  'cancelled',
] as const

// Manual payment dimension (separate from fulfilment status).
export const PAYMENT_STATUSES = [
  'awaiting_payment',
  'payment_review',
  'paid',
  'rejected',
  'refund_pending',
  'refunded',
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export function serializeOrderItem(i: OrderItem) {
  return {
    id: i.id,
    productId: i.productId,
    productNameSnapshot: i.productNameSnapshot,
    unitPriceSnapshot: i.unitPriceSnapshot,
    quantity: i.quantity,
    total: i.total,
  }
}

type ListCustomer = { id: string; firstName: string; telegramUsername: string | null }

type LatestPayment = Pick<
  Payment,
  | 'id'
  | 'status'
  | 'receiptUrl'
  | 'payerName'
  | 'trackingNumber'
  | 'customerNote'
  | 'reviewNote'
  | 'reviewedAt'
  | 'createdAt'
>

export function serializeOrder(
  o: Order & { customer: ListCustomer; items: OrderItem[]; payments?: LatestPayment[] },
) {
  const payment = o.payments?.[0] ?? null
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    trackingCode: o.trackingCode,
    subtotal: o.subtotal,
    discount: o.discount,
    total: o.total,
    address: o.address,
    phone: o.phone,
    customerName: o.customerName,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    customer: o.customer,
    items: o.items.map(serializeOrderItem),
    // Latest payment attempt (receipt summary) or null.
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          receiptUrl: payment.receiptUrl,
          payerName: payment.payerName,
          trackingNumber: payment.trackingNumber,
          customerNote: payment.customerNote,
          reviewNote: payment.reviewNote,
          reviewedAt: payment.reviewedAt,
          createdAt: payment.createdAt,
        }
      : null,
  }
}

export const ORDER_INCLUDE = {
  customer: { select: { id: true, firstName: true, telegramUsername: true } },
  items: true,
  payments: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
  },
} satisfies Prisma.OrderInclude
