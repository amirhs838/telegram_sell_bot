/**
 * bot-service — order business logic.
 *
 * createOrder(): transactional stock decrement + order/item creation with
 *                name & price snapshots + atomic order number allocation.
 * setOrderStatus(): status transitions; cancelling restocks items and restores
 *                out-of-stock products; notifies the customer via Telegram.
 *
 * NOTE: seller/customer notifications are best-effort (never break the tx result).
 */
import { formatMoney } from '../../src/lib/telegram-render'
import { db } from './db'
import { loadConfig, send } from './telegram'

export class InsufficientStockError extends Error {
  readonly available: number
  constructor(available: number) {
    super(`insufficient stock: ${available}`)
    this.available = available
  }
}

export class ProductUnavailableError extends Error {
  constructor() {
    super('product missing or not active')
  }
}

const VALID_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled']

export const PAYMENT_STATUSES = [
  'awaiting_payment',
  'payment_review',
  'paid',
  'rejected',
  'refund_pending',
  'refunded',
] as const

export type OrderItemInput = { productId: string; quantity: number }

export type CreateOrderInput = {
  customer: { telegramUserId: string; firstName: string; username?: string | null }
  productId: string
  quantity: number
  name: string
  phone: string
  address: string
}

export type CreateOrderMultiInput = {
  customer: { telegramUserId: string; firstName: string; username?: string | null }
  items: OrderItemInput[]
  name: string
  phone: string
  address: string
}

/**
 * Transactional multi-item order creation:
 * stock check + decrement per item, atomic order number, customer upsert,
 * name/price snapshots, out-of-stock flip, activity log.
 */
export async function createOrderMulti(input: CreateOrderMultiInput) {
  const { customer, items, name, phone, address } = input
  if (!Array.isArray(items) || items.length === 0) {
    throw new ProductUnavailableError()
  }

  const order = await db.$transaction(async (tx) => {
    // a. fetch + validate every product first
    const products = []
    for (const it of items) {
      const product = await tx.product.findUnique({ where: { id: it.productId } })
      if (!product || product.status !== 'active') {
        throw new ProductUnavailableError()
      }
      if (it.quantity < 1) {
        throw new InsufficientStockError(product.stock)
      }
      products.push({ product, quantity: it.quantity })
    }

    // b. atomic conditional decrement per item
    for (const { product, quantity } of products) {
      const updated = await tx.product.updateMany({
        where: { id: product.id, stock: { gte: quantity } },
        data: { stock: { decrement: quantity } },
      })
      if (updated.count === 0) {
        throw new InsufficientStockError(product.stock)
      }
    }

    // c. atomic order number allocation
    const counter = await tx.counter.upsert({
      where: { name: 'order' },
      create: { name: 'order', value: 1 },
      update: { value: { increment: 1 } },
    })
    const orderNumber = counter.value

    // d. upsert customer by telegramUserId
    const dbCustomer = await tx.customer.upsert({
      where: { telegramUserId: customer.telegramUserId },
      create: {
        telegramUserId: customer.telegramUserId,
        firstName: customer.firstName,
        lastName: null,
        phone,
        address,
        telegramUsername: customer.username ?? null,
      },
      update: {
        firstName: customer.firstName,
        phone,
        address,
        telegramUsername: customer.username ?? null,
      },
    })

    const subtotal = products.reduce((s, x) => s + x.product.price * x.quantity, 0)

    // e. order (customerName is a snapshot)
    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: dbCustomer.id,
        status: 'pending',
        subtotal,
        discount: 0,
        total: subtotal,
        customerName: name,
        address,
        phone,
      },
    })

    // f. order items (name + unit price snapshots)
    for (const { product, quantity } of products) {
      await tx.orderItem.create({
        data: {
          orderId: created.id,
          productId: product.id,
          productNameSnapshot: product.name,
          unitPriceSnapshot: product.price,
          quantity,
          total: product.price * quantity,
        },
      })
    }

    // g. stock hit zero → mark out of stock
    for (const { product, quantity } of products) {
      const remaining = product.stock - quantity
      if (remaining === 0) {
        await tx.product.update({ where: { id: product.id }, data: { status: 'out_of_stock' } })
      }
    }

    // h. payment shell — awaiting payment, exact amount snapshot
    await tx.payment.create({
      data: {
        orderId: created.id,
        status: 'awaiting_payment',
        amountSnapshot: subtotal,
      },
    })

    // i. activity log — NO phone/address (privacy)
    await tx.activityLog.create({
      data: {
        level: 'info',
        type: 'order.created',
        message: `سفارش #${orderNumber} ثبت شد`,
        data: JSON.stringify({
          orderId: created.id,
          items: products.map((x) => ({ productId: x.product.id, quantity: x.quantity })),
          total: created.total,
          telegramUserId: customer.telegramUserId,
        }),
      },
    })

    return { order: created, products }
  })

  // Seller notification (best-effort, after commit)
  const { adminChatId: adminChat } = await loadConfig()
  if (adminChat) {
    try {
      const itemLines = order.products.map(
        (x) => `🛍 ${x.product.name} × ${x.quantity} — ${formatMoney(x.product.price * x.quantity)}`,
      )
      await send(
        adminChat,
        [
          '🔔 سفارش جدید',
          '',
          `#${order.order.orderNumber}`,
          '',
          `👤 مشتری: ${name}`,
          `📱 ${phone}`,
          `📍 ${address}`,
          '',
          ...itemLines,
          `💳 مبلغ کل: ${formatMoney(order.order.total)}`,
          '',
          '🟡 در انتظار بررسی',
        ].join('\n'),
        [
          [
            { text: '✅ تأیید', callback_data: `seller:confirm:${order.order.id}` },
            { text: '❌ لغو', callback_data: `seller:cancel:${order.order.id}` },
          ],
        ],
      )
    } catch {
      // never fail the order because of notification
    }
  }

  return order.order
}

/** Single-item convenience wrapper (legacy flow + deep links). */
export async function createOrder(input: CreateOrderInput) {
  return createOrderMulti({
    customer: input.customer,
    items: [{ productId: input.productId, quantity: input.quantity }],
    name: input.name,
    phone: input.phone,
    address: input.address,
  })
}

/**
 * Change order status (seller action).
 * Cancelling (from a non-cancelled state) restocks every item and flips
 * products that were out_of_stock back to active.
 */
export async function setOrderStatus(
  orderId: string,
  status: string,
): Promise<{ ok: boolean; order?: { id: string; orderNumber: number; status: string; customerTelegramUserId?: string }; error?: string }> {
  if (!VALID_STATUSES.includes(status)) {
    return { ok: false, error: 'invalid status' }
  }

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true, customer: true },
    })
    if (!existing) return { ok: false as const, error: 'order not found' }

    const previous = existing.status
    const isRestock = status === 'cancelled' && previous !== 'cancelled'

    if (isRestock) {
      for (const item of existing.items) {
        if (!item.productId) continue
        const product = await tx.product.findUnique({ where: { id: item.productId } })
        if (!product) continue
        await tx.product.update({
          where: { id: product.id },
          data: {
            stock: { increment: item.quantity },
            ...(product.status === 'out_of_stock' ? { status: 'active' } : {}),
          },
        })
      }
    }

    const updated = await tx.order.update({ where: { id: orderId }, data: { status } })

    await tx.activityLog.create({
      data: {
        level: 'info',
        type: 'order.status_changed',
        message: `وضعیت سفارش #${existing.orderNumber} به «${status}» تغییر کرد`,
        data: JSON.stringify({ orderId, from: previous, to: status, restocked: isRestock }),
      },
    })

    return {
      ok: true as const,
      order: {
        id: updated.id,
        orderNumber: updated.orderNumber,
        status: updated.status,
        customerTelegramUserId: existing.customer.telegramUserId,
      },
    }
  })

  if (result.ok && result.order?.customerTelegramUserId) {
    const n = result.order.orderNumber
    const text = customerStatusMessage(status, n)
    if (text) {
      try {
        await send(result.order.customerTelegramUserId, text)
      } catch {
        // best-effort
      }
    }
  }
  return result
}

function customerStatusMessage(status: string, orderNumber: number): string | null {
  switch (status) {
    case 'confirmed':
      return `🟢 سفارش #${orderNumber} شما تأیید شد!`
    case 'processing':
      return `🔵 سفارش #${orderNumber} شما در حال پردازش است.`
    case 'shipped':
      return `🚚 سفارش #${orderNumber} شما ارسال شد!`
    case 'completed':
      return `✅ سفارش #${orderNumber} شما تکمیل شد. از خرید شما سپاسگزاریم! 🙏`
    case 'cancelled':
      return `🔴 سفارش #${orderNumber} شما لغو شد و مبلغ بازگردانده خواهد شد.`
    default:
      return null
  }
}

// ─── Manual payment lifecycle (Silver Love) ────────────────────────────────

export function paymentStatusFa(status: string): string {
  switch (status) {
    case 'awaiting_payment':
      return 'در انتظار پرداخت'
    case 'payment_review':
      return 'رسید در انتظار بررسی'
    case 'paid':
      return 'پرداخت تأیید شده'
    case 'rejected':
      return 'پرداخت رد شده'
    case 'refund_pending':
      return 'بازپرداخت در انتظار'
    case 'refunded':
      return 'بازپرداخت شد'
    default:
      return status
  }
}

/** Active bank destination for customer payment instructions. */
export async function getActiveBankAccount() {
  return db.bankAccount.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } })
}

/**
 * Attach a receipt image to the customer's latest payable order
 * (awaiting_payment or rejected). Idempotent per state — resubmission is
 * allowed after a rejection. Admin approval is ALWAYS manual (panel).
 */
export async function attachReceiptToOrder(
  orderId: string,
  receipt: { receiptImage: string; payerName?: string | null; trackingNumber?: string | null; customerNote?: string | null },
): Promise<{ ok: boolean; orderNumber?: number; status?: string; error?: string }> {
  const payment = await db.payment.findUnique({ where: { orderId }, include: { order: true } })
  if (!payment) return { ok: false, error: 'payment missing' }
  if (payment.status === 'paid') {
    return { ok: false, orderNumber: payment.order.orderNumber, status: payment.status, error: 'already paid' }
  }
  if (payment.status === 'refunded' || payment.status === 'refund_pending') {
    return { ok: false, orderNumber: payment.order.orderNumber, status: payment.status, error: 'refunded' }
  }
  const isResubmit = payment.status === 'rejected' || payment.status === 'payment_review'
  const updated = await db.payment.update({
    where: { id: payment.id },
    data: {
      status: 'payment_review',
      receiptImage: receipt.receiptImage,
      payerName: receipt.payerName ?? payment.payerName,
      trackingNumber: receipt.trackingNumber ?? payment.trackingNumber,
      customerNote: receipt.customerNote ?? payment.customerNote,
      rejectReason: null,
      events: {
        create: {
          type: isResubmit ? 'resubmitted' : 'receipt_submitted',
          note: 'رسید جدید توسط مشتری ارسال شد',
        },
      },
    },
  })
  await db.activityLog.create({
    data: {
      level: 'info',
      type: 'payment.receipt_submitted',
      message: `رسید پرداخت سفارش #${payment.order.orderNumber} دریافت شد — در انتظار بررسی ادمین`,
      data: JSON.stringify({ orderId: orderId, paymentId: payment.id }),
    },
  })
  return { ok: true, orderNumber: payment.order.orderNumber, status: updated.status }
}

/** Customer's most recent order whose payment can receive a receipt. */
export async function findPayableOrderForCustomer(telegramUserId: string) {
  const customer = await db.customer.findUnique({ where: { telegramUserId } })
  if (!customer) return null
  return db.order.findFirst({
    where: { customerId: customer.id, payment: { status: { in: ['awaiting_payment', 'rejected'] } } },
    orderBy: { createdAt: 'desc' },
    include: { payment: true },
  })
}
