import type { Payment } from '@prisma/client'

export const PAYMENT_REVIEW_STATUSES = ['awaiting_review', 'approved', 'rejected'] as const

export type PaymentReviewStatus = (typeof PAYMENT_REVIEW_STATUSES)[number]

export type PaymentOrderSummary = {
  id: string
  orderNumber: number
  total: number
  status: string
  paymentStatus: string
  customerName: string
  phone: string
  items: Array<{
    productNameSnapshot: string
    quantity: number
    unitPriceSnapshot: number
  }>
}

/** Contract shape for the payments review screen. */
export function serializePayment(p: Payment, order: PaymentOrderSummary) {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    receiptUrl: p.receiptUrl,
    payerName: p.payerName,
    trackingNumber: p.trackingNumber,
    customerNote: p.customerNote,
    reviewNote: p.reviewNote,
    reviewedByName: p.reviewedByName,
    reviewedAt: p.reviewedAt,
    createdAt: p.createdAt,
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      total: order.total,
      status: order.status,
      paymentStatus: order.paymentStatus,
      customerName: order.customerName,
      phone: order.phone,
      items: order.items.map((i) => ({
        productNameSnapshot: i.productNameSnapshot,
        quantity: i.quantity,
        unitPriceSnapshot: i.unitPriceSnapshot,
      })),
    },
  }
}
