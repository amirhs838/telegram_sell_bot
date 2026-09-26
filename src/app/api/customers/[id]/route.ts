import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { mapCustomer } from '../shared'

export const GET = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const customer = await db.customer.findUnique({
      where: { id },
      include: { orders: { include: { items: true }, orderBy: { createdAt: 'desc' } } },
    })
    if (!customer) throw new ApiError(404, 'مشتری یافت نشد')

    // Stats over ALL orders; detail list limited to the last 20.
    const stats = mapCustomer(customer, customer.orders)
    const orders = customer.orders.slice(0, 20)

    return ok({ customer: stats, orders })
  },
)
