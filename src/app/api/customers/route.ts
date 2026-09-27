import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { mapCustomer, sortByLastOrderDesc } from './shared'

export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const sp = req.nextUrl.searchParams
  const search = sp.get('search')?.trim()
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '50', 10) || 50))

  const where: Prisma.CustomerWhereInput = search
    ? {
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { telegramUsername: { contains: search } },
          { phone: { contains: search } },
        ],
      }
    : {}

  // Stats (totalOrders/totalSpent/lastOrderAt) are computed over ALL orders of each
  // customer, so fetch every match and paginate in memory after sorting.
  const customers = await db.customer.findMany({
    where,
    include: { orders: { select: { total: true, status: true, createdAt: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const mapped = sortByLastOrderDesc(customers.map((c) => mapCustomer(c, c.orders)))

  return ok({
    items: mapped.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
    total: mapped.length,
  })
})
