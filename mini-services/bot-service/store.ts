/**
 * bot-service — store helpers: settings + catalog queries used by the engine.
 */
import { db } from './db'

export type StoreSettings = {
  storeName: string
  storeDescription: string
  supportUsername: string
}

const DEFAULTS: StoreSettings = {
  storeName: 'فروشگاه من',
  storeDescription: '',
  supportUsername: '',
}

export async function getStoreSettings(): Promise<StoreSettings> {
  try {
    const rows = await db.setting.findMany()
    const map = new Map(rows.map((r) => [r.key, r.value]))
    return {
      storeName: map.get('storeName') || DEFAULTS.storeName,
      storeDescription: map.get('storeDescription') || DEFAULTS.storeDescription,
      supportUsername: map.get('supportUsername') || DEFAULTS.supportUsername,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function listCategories() {
  return db.category.findMany({ orderBy: { createdAt: 'asc' } })
}

export async function getCategory(id: string) {
  return db.category.findUnique({ where: { id } })
}

export async function countActiveProductsByCategory(categoryId: string): Promise<number> {
  return db.product.count({ where: { categoryId, status: 'active' } })
}

export async function listActiveProductsByCategory(categoryId: string, page: number, perPage = 5) {
  const [items, total] = await Promise.all([
    db.product.findMany({
      where: { categoryId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.product.count({ where: { categoryId, status: 'active' } }),
  ])
  return { items, total }
}

export async function getProduct(id: string) {
  return db.product.findUnique({ where: { id }, include: { category: true } })
}

/** Search active products for the bot search flow / AI fallback. */
export async function searchActiveProducts(query: string, limit = 8) {
  const q = query.trim()
  if (!q) return []
  return db.product.findMany({
    where: {
      status: 'active',
      OR: [
        { name: { contains: q } },
        { shortDescription: { contains: q } },
        { description: { contains: q } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
