import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { unpublishProduct } from '@/lib/telegram'

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const product = await db.product.findUnique({ where: { id } })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    // Removes the channel post + mapping. Best-effort — never throws.
    await unpublishProduct(product)

    return ok({ ok: true })
  },
)
