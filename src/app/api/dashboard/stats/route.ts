import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'

const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled'] as const

export const GET = route(async () => {
  await requireAuth()

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const weekStart = new Date(startOfToday)
  weekStart.setDate(weekStart.getDate() - 6)

  const [
    products,
    activeProducts,
    lowStock,
    outOfStock,
    customers,
    pendingOrders,
    todayOrders,
    salesAgg,
    statusGroups,
    last7DaysOrders,
    recentOrders,
  ] = await Promise.all([
    db.product.count(),
    db.product.count({ where: { status: 'active' } }),
    db.product.count({ where: { stock: { gt: 0, lte: 5 } } }),
    db.product.count({ where: { stock: { lte: 0 } } }),
    db.customer.count(),
    db.order.count({ where: { status: 'pending' } }),
    db.order.count({ where: { createdAt: { gte: startOfToday } } }),
    db.order.aggregate({ _sum: { total: true }, where: { status: { not: 'cancelled' } } }),
    db.order.groupBy({ by: ['status'], _count: { _all: true } }),
    db.order.findMany({
      where: { createdAt: { gte: weekStart } },
      select: { createdAt: true, total: true, status: true },
    }),
    db.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { id: true, orderNumber: true, customerName: true, total: true, status: true, createdAt: true },
    }),
  ])

  const statusCounts: Record<(typeof ORDER_STATUSES)[number], number> = {
    pending: 0,
    confirmed: 0,
    processing: 0,
    shipped: 0,
    completed: 0,
    cancelled: 0,
  }
  for (const g of statusGroups) {
    if ((ORDER_STATUSES as readonly string[]).includes(g.status)) {
      statusCounts[g.status as (typeof ORDER_STATUSES)[number]] = g._count._all
    }
  }

  // Bucket the last 7 days (oldest → newest) by local calendar day.
  const weekly: Array<{ date: string; orders: number; sales: number }> = []
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(startOfToday)
    dayStart.setDate(dayStart.getDate() - i)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)
    const dayOrders = last7DaysOrders.filter(
      (o) => o.createdAt >= dayStart && o.createdAt < dayEnd,
    )
    weekly.push({
      date: `${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`,
      orders: dayOrders.length,
      sales: dayOrders
        .filter((o) => o.status !== 'cancelled')
        .reduce((sum, o) => sum + o.total, 0),
    })
  }

  return ok({
    totals: {
      products,
      activeProducts,
      lowStock,
      outOfStock,
      pendingOrders,
      todayOrders,
      totalSales: salesAgg._sum.total ?? 0,
      customers,
    },
    weekly,
    recentOrders,
    statusCounts,
  })
})
