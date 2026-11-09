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
import { notifyAdmin, sendToCustomer } from './telegram'

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

export type CreateOrderInput = {
  customer: {
    telegramUserId: string
    /** Real Telegram profile name — the ONLY thing written to Customer.firstName */
    telegramFirstName?: string | null
    username?: string | null
  }
  productId: string
  quantity: number
  /** Full name the customer typed — stored ONLY in the Order.customerName snapshot */
  name: string
  phone: string
  address: string
}

export async function createOrder(input: CreateOrderInput) {
  const { customer, productId, quantity, name, phone, address } = input

  const order = await db.$transaction(async (tx) => {
    // a. re-fetch product — must exist and be active
    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product || product.status !== 'active') {
      throw new ProductUnavailableError()
    }

    // b. atomic conditional decrement (race-safe on SQLite single-writer)
    const updated = await tx.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    })
    if (updated.count === 0) {
      throw new InsufficientStockError(product.stock)
    }
    const remainingStock = product.stock - quantity

    // c. atomic order number allocation
    const counter = await tx.counter.upsert({
      where: { name: 'order' },
      create: { name: 'order', value: 1 },
      update: { value: { increment: 1 } },
    })
    const orderNumber = counter.value

    // d. upsert customer by telegramUserId — Customer.firstName always keeps the
    //    REAL Telegram profile name; the typed full name goes only into the
    //    Order.customerName snapshot below (bug fix: never overwrite the profile name).
    const dbCustomer = await tx.customer.upsert({
      where: { telegramUserId: customer.telegramUserId },
      create: {
        telegramUserId: customer.telegramUserId,
        firstName: customer.telegramFirstName || name,
        lastName: null,
        phone,
        address,
        telegramUsername: customer.username ?? null,
      },
      update: {
        phone,
        address,
        telegramUsername: customer.username ?? null,
        // firstName intentionally NOT updated — Telegram profile is the source of truth
      },
    })

    // e. order (customerName is a snapshot)
    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: dbCustomer.id,
        status: 'pending',
        subtotal: product.price * quantity,
        discount: 0,
        total: product.price * quantity,
        customerName: name, // snapshot of the name the customer typed
        paymentStatus: 'awaiting_payment',
        address,
        phone,
      },
    })

    // f. order item (name + unit price snapshots)
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

    // g. stock hit zero → mark out of stock
    if (remainingStock === 0) {
      await tx.product.update({ where: { id: product.id }, data: { status: 'out_of_stock' } })
    }

    // h. activity log — NO phone/address (privacy)
    await tx.activityLog.create({
      data: {
        level: 'info',
        type: 'order.created',
        message: `سفارش #${orderNumber} ثبت شد`,
        data: JSON.stringify({
          orderId: created.id,
          productId: product.id,
          quantity,
          total: created.total,
          telegramUserId: customer.telegramUserId,
        }),
      },
    })

    return { order: created, product, remainingStock }
  })

  // Seller notification (best-effort, after commit) — every connected platform
  try {
    await notifyAdmin(
      [
        '🔔 سفارش جدید',
        '',
        `#${order.order.orderNumber}`,
        '',
        `👤 مشتری: ${name}`,
        `📱 ${phone}`,
        `📍 ${address}`,
        '',
        `🛍 ${order.product.name}`,
        `🔢 تعداد: ${quantity}`,
        `💰 مبلغ: ${formatMoney(order.order.total)}`,
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

  return order.order
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
        // routes by chat-id prefix: Bale customers (bale:…) on Bale, the rest on Telegram
        await sendToCustomer(result.order.customerTelegramUserId, text)
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
