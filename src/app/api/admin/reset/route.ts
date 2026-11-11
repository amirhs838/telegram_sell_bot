// Danger-zone: irreversible database reset for the catalog / sales data.
// Requires an admin session + an explicit Persian confirmation word («ریست»).
// Deletion order respects the FK graph (Order→Customer is Restrict, so
// orders die before customers). Settings, admin users, payment destinations
// and the silver rate are NEVER touched. Physical upload files stay on disk.
import { z } from 'zod'
import { ok, readJson, requireAuth, route, ApiError } from '@/lib/api'
import { logEvent } from '@/lib/logger'
import { db } from '@/lib/db'

const bodySchema = z.object({
  scope: z.enum(['catalog', 'sales', 'all']),
  // the UI forces the user to type this word — the API enforces it too
  confirm: z.literal('ریست'),
})

export const POST = route(async (req) => {
  const user = await requireAuth()
  if (user.role !== 'admin') {
    throw new ApiError(403, 'فقط مدیر فروشگاه اجازهٔ ریست دیتابیس را دارد')
  }

  const body = await readJson<unknown>(req)
  const { scope } = bodySchema.parse(body)

  const before = {
    products: await db.product.count(),
    categories: await db.category.count(),
    orders: await db.order.count(),
    customers: await db.customer.count(),
    chatMessages: await db.chatMessage.count(),
  }

  const wipedCatalog = scope === 'catalog' || scope === 'all'
  const wipedSales = scope === 'sales' || scope === 'all'

  const result = await db.$transaction(async (tx) => {
    const counts: Record<string, number> = {}
    if (wipedCatalog) {
      counts.productEmbeddings = await tx.productEmbedding.deleteMany().then((r) => r.count)
      counts.products = await tx.product.deleteMany().then((r) => r.count)
      counts.categories = await tx.category.deleteMany().then((r) => r.count)
    }
    if (wipedSales) {
      // FK order: payments → order items → orders → conversations → sessions → customers
      counts.payments = await tx.payment.deleteMany().then((r) => r.count)
      counts.orderItems = await tx.orderItem.deleteMany().then((r) => r.count)
      counts.orders = await tx.order.deleteMany().then((r) => r.count)
      counts.chatMessages = await tx.chatMessage.deleteMany().then((r) => r.count)
      counts.botSessions = await tx.botSession.deleteMany().then((r) => r.count)
      counts.customers = await tx.customer.deleteMany().then((r) => r.count)
      // order number sequence restarts from zero on a full sales wipe
      counts.counters = await tx.counter.deleteMany().then((r) => r.count)
    }
    return counts
  })

  await logEvent(
    'db.reset',
    `بازنشانی دیتابیس (${scope}) توسط ${user.email}`,
    { scope, deleted: result, before },
    'warn',
  )

  return ok({
    ok: true,
    scope,
    deleted: result,
    message: 'بازنشانی با موفقیت انجام شد. فایل‌های تصویری روی دیسک باقی مانده‌اند.',
  })
})
