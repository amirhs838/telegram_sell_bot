import { ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { EMBEDDING_MODEL } from '@/lib/ai/embedding'

export const GET = route(async () => {
  await requireAuth()

  const [total, products] = await Promise.all([
    db.productEmbedding.count(),
    db.product.count(),
  ])

  return ok({ total, products, model: EMBEDDING_MODEL })
})
