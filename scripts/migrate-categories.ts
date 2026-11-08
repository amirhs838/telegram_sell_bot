/**
 * Category restructure — owner-approved menu (v2.2.8):
 *   👩 زیور زنانه وارداتی → women-imported
 *   👨 زیور مردانه وارداتی → men-imported
 *   🔥 آفرهای هفتگی       → weekly-offers  (smart: lists live discounts)
 *   💎 سرمایه‌گذاری        → investment
 * Reassigns every product, then removes the old 6 demo categories.
 * Run: bun scripts/migrate-categories.ts   (idempotent)
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const NEW_CATS = [
  { slug: 'women-imported', name: '👩 زیور زنانه وارداتی', description: 'زیورآلات وارداتی زنانه — گردنبند، انگشتر، گوشواره، دستبند و ست' },
  { slug: 'men-imported', name: '👨 زیور مردانه وارداتی', description: 'زیورآلات وارداتی مردانه — دستبند، زنجیر و انگشتر' },
  { slug: 'weekly-offers', name: '🔥 آفرهای هفتگی', description: 'تخفیف‌های ویژه این هفته — به‌صورت خودکار از محصولات تخفیف‌دار ساخته می‌شود' },
  { slug: 'investment', name: '💎 سرمایه‌گذاری', description: 'شمش نقره و زیورآلات با ارزش سرمایه‌گذاری' },
]

const OLD_SLUGS = ['ring', 'bracelet', 'necklace', 'earring', 'gift-set', 'silver-bar']

/** product slug → new category slug */
const PRODUCT_MAP: Record<string, string> = {
  'nagarin-silver-ring': 'women-imported',
  'baran-silver-earrings': 'women-imported',
  'delnagare-heart-necklace': 'women-imported',
  'naz-silver-bracelet': 'women-imported',
  'star-moon-pendant': 'women-imported',
  'rosegold-gift-set': 'women-imported',
  'aryo-silver-bracelet': 'men-imported',
  'cuba-silver-chain': 'men-imported',
  'firuzeh-men-ring': 'men-imported',
  'silver-bar-50g': 'investment',
}

async function main() {
  const catIds: Record<string, string> = {}
  for (const c of NEW_CATS) {
    const row = await db.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { name: c.name, description: c.description },
    })
    catIds[c.slug] = row.id
  }
  console.log(`✓ ${NEW_CATS.length} new categories (order preserved)`)

  let moved = 0
  for (const [productSlug, catSlug] of Object.entries(PRODUCT_MAP)) {
    const p = await db.product.findUnique({ where: { slug: productSlug }, select: { id: true } })
    if (!p) continue
    await db.product.update({ where: { id: p.id }, data: { categoryId: catIds[catSlug] } })
    moved++
  }
  console.log(`✓ ${moved} products reassigned`)

  const del = await db.category.deleteMany({ where: { slug: { in: OLD_SLUGS } } })
  console.log(`✓ ${del.count} old categories removed`)

  const cats = await db.category.findMany({ orderBy: { createdAt: 'asc' }, select: { name: true, slug: true } })
  console.log('── final categories (menu order) ──')
  for (const c of cats) console.log(`  ${c.name}  (${c.slug})`)
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
