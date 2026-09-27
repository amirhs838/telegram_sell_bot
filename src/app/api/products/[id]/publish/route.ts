import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { publishProductToChannel, TelegramApiError } from '@/lib/telegram'
import { PRODUCT_INCLUDE, serializeProduct } from '../../shared'

export const POST = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const product = await db.product.findUnique({ where: { id } })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    if (product.status !== 'active') {
      throw new ApiError(400, 'فقط محصولات فعال قابل انتشار در کانال هستند')
    }

    try {
      await publishProductToChannel(product)
    } catch (e) {
      if (e instanceof TelegramApiError) {
        await logEvent(
          'telegram_error',
          `انتشار محصول «${product.name}» در کانال ناموفق بود: ${e.message}`,
          { productId: product.id, method: e.method },
          'error',
        )
        throw new ApiError(502, `انتشار در کانال ناموفق بود: ${e.message}`)
      }
      throw e
    }

    const refreshed = await db.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    })

    return ok({ product: refreshed ? serializeProduct(refreshed) : null })
  },
)
