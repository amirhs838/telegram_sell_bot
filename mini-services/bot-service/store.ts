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

/**
 * Active products with a LIVE discount (compareAtPrice set AND greater than the
 * final price) — powers the «🔥 آفرهای هفتگی» smart category in the products
 * menu. compareAtPrice is the pre-discount price; it is never shown as a
 * standalone category assignment, so the list stays automatic.
 */
export async function listActiveDiscountedProducts(page: number, perPage = 5) {
  const where = {
    status: 'active' as const,
    compareAtPrice: { gt: db.product.fields.price },
  }
  const [items, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.product.count({ where }),
  ])
  return { items, total }
}

/**
 * Product with gallery images (primary first, then sortOrder) + silver specs.
 * NOTE: `price` is the seller-approved final price — NEVER recomputed from
 * silver rate × weight anywhere in the bot (pricing law).
 */
export async function getProduct(id: string) {
  return db.product.findUnique({
    where: { id },
    include: {
      category: true,
      images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
    },
  })
}

/** Search active products for the bot search flow / AI fallback (text lists only). */
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

/** Active card-to-card destinations shown to the customer after checkout. */
export async function getActivePaymentDestinations() {
  return db.paymentDestination.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  })
}

/** Latest active manual silver rate (admin-entered reference info only). */
export async function getLatestSilverRate() {
  return db.silverRate.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } })
}
