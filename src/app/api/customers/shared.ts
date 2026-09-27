import type { Customer, Order } from '@prisma/client'

type OrderStats = Pick<Order, 'total' | 'status' | 'createdAt'>

export function mapCustomer(c: Customer, orders: OrderStats[]) {
  const nonCancelled = orders.filter((o) => o.status !== 'cancelled')
  const lastOrderAt = orders.reduce<Order['createdAt'] | null>(
    (max, o) => (!max || o.createdAt > max ? o.createdAt : max),
    null,
  )
  return {
    id: c.id,
    telegramUserId: c.telegramUserId,
    telegramUsername: c.telegramUsername,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    address: c.address,
    totalOrders: orders.length,
    totalSpent: nonCancelled.reduce((sum, o) => sum + o.total, 0),
    lastOrderAt,
    createdAt: c.createdAt,
  }
}

/** Sort by lastOrderAt desc, customers without orders last (stable by name then). */
export function sortByLastOrderDesc<T extends { lastOrderAt: Date | null; firstName: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (a.lastOrderAt && b.lastOrderAt) return b.lastOrderAt.getTime() - a.lastOrderAt.getTime()
    if (a.lastOrderAt) return -1
    if (b.lastOrderAt) return 1
    return a.firstName.localeCompare(b.firstName, 'fa')
  })
}
