import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { ORDER_INCLUDE, ORDER_STATUSES, serializeOrder } from './shared'

export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')?.trim()
  const search = sp.get('search')?.trim()
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '20', 10) || 20))

  const where: Prisma.OrderWhereInput = {}
  if (status && (ORDER_STATUSES as readonly string[]).includes(status)) {
    where.status = status
  }
  if (search) {
    const isNumeric = /^\d+$/.test(search)
    where.OR = [
      { customerName: { contains: search } },
      { phone: { contains: search } },
      ...(isNumeric ? [{ orderNumber: Number.parseInt(search, 10) }] : []),
    ]
  }

  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.order.count({ where }),
  ])

  return ok({ items: rows.map(serializeOrder), total, page, pageSize })
})
