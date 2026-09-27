/**
 * bot-service — test fixtures & cleanup (dev only).
 *   bun test-fixtures.ts create    → creates test category + product, prints ids
 *   bun test-fixtures.ts cleanup   → removes test data (orders, customer, product, category, counter, sessions, logs)
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function create() {
  const cat = await db.category.create({
    data: { name: 'تست', slug: `test-cat-${Date.now()}` },
  })
  const prod = await db.product.create({
    data: {
      name: 'کفش تست',
      slug: `test-shoe-${Date.now()}`,
      shortDescription: 'یک کفش ورزشی برای تست ربات',
      description: 'توضیحات کامل کفش تستی برای بررسی جریان سفارش ربات تلگرامی.',
      price: 1_850_000,
      stock: 10,
      status: 'active',
      categoryId: cat.id,
    },
  })
  console.log(JSON.stringify({ categoryId: cat.id, productId: prod.id }))
}

async function cleanup() {
  // delete test bot sessions
  const sessions = await db.botSession.findMany()
  let sessionCount = 0
  for (const s of sessions) {
    if (s.telegramUserId.includes('test-user') || s.telegramUserId.includes('admin-test')) {
      await db.botSession.delete({ where: { telegramUserId: s.telegramUserId } })
      sessionCount++
    }
  }

  // orders created by the test flow (customerName/tag traceable via activity logs)
  const logs = await db.activityLog.findMany({ where: { type: 'order.created' } })
  const orderIds = new Set<string>()
  for (const l of logs) {
    try {
      const data = JSON.parse(l.data ?? '{}')
      if (typeof data.telegramUserId === 'string' && data.telegramUserId.includes('test-user')) {
        orderIds.add(data.orderId as string)
      }
    } catch {
      /* ignore */
    }
  }
  for (const orderId of orderIds) {
    await db.orderItem.deleteMany({ where: { orderId } })
    await db.order.delete({ where: { id: orderId } }).catch(() => {})
  }

  // customer
  const custDeleted = await db.customer.deleteMany({
    where: { telegramUserId: { contains: 'test-user' } },
  })

  // products + category by name/slug prefix
  const prods = await db.product.findMany({ where: { name: 'کفش تست' } })
  const catIds = new Set<string>()
  for (const p of prods) {
    if (p.categoryId) catIds.add(p.categoryId)
    await db.product.delete({ where: { id: p.id } })
  }
  let catCount = 0
  for (const catId of catIds) {
    const cat = await db.category.findUnique({ where: { id: catId } })
    if (cat?.slug.startsWith('test-cat-')) {
      await db.category.delete({ where: { id: catId } })
      catCount++
    }
  }

  // counter (only if it matches the test order count we deleted)
  await db.counter.deleteMany({ where: { name: 'order' } })

  // activity logs of the test run
  const logsDeleted = await db.activityLog.deleteMany({
    where: {
      OR: [
        { type: 'order.created' },
        { type: 'order.status_changed' },
        { type: 'bot.error' },
        { type: 'telegram_out', data: { contains: 'test-user' } },
      ],
    },
  })

  console.log(
    JSON.stringify({
      ok: true,
      orders: orderIds.size,
      customers: custDeleted.count,
      products: prods.length,
      categories: catCount,
      sessions: sessionCount,
      logs: logsDeleted.count,
    }),
  )
}

const mode = process.argv[2] ?? 'create'
if (mode === 'create') {
  await create()
} else if (mode === 'cleanup') {
  await cleanup()
} else {
  console.error('usage: bun test-fixtures.ts [create|cleanup]')
  process.exit(1)
}
await db.$disconnect()
