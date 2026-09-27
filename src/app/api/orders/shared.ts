import type { Order, OrderItem } from '@prisma/client'
import type { Prisma } from '@prisma/client'

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'completed',
  'cancelled',
] as const

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

export function serializeOrder(
  o: Order & { customer: ListCustomer; items: OrderItem[] },
) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
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
  }
}

export const ORDER_INCLUDE = {
  customer: { select: { id: true, firstName: true, telegramUsername: true } },
  items: true,
} satisfies Prisma.OrderInclude
