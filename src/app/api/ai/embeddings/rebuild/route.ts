import { ok, requireAuth, route } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import { rebuildAllEmbeddings } from '@/lib/ai/embedding'

export const POST = route(async () => {
  await requireAuth()

  const { count } = await rebuildAllEmbeddings()

  await logEvent('ai.embeddings.rebuild', 'بردارهای معنایی محصولات بازسازی شد', { count })

  return ok({ count })
})
