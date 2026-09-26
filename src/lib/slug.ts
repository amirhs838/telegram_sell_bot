import { db } from '@/lib/db'

/**
 * Sanitize a human title into a URL-safe slug:
 *  - trim + lowercase
 *  - whitespace runs → '-'
 *  - strip chars not [\p{L}\p{N}-] (unicode letters & digits are kept — Persian OK)
 *  - collapse consecutive '-'
 *  - trim edge dashes, cap at 80 chars
 *  - empty result → 'item'
 */
function sanitizeSlug(base: string): string {
  const s = base
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '')
  return s || 'item'
}

/**
 * Generate a unique slug for the given Prisma model.
 * Tries `slug`, `slug-2`, `slug-3`, … until a free one is found.
 * `excludeId` allows the entity itself to keep its current slug.
 */
export async function uniqueSlug(
  base: string,
  model: 'product' | 'category',
  excludeId?: string,
): Promise<string> {
  const baseSlug = sanitizeSlug(base)
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? baseSlug : `${baseSlug}-${i}`
    const found =
      model === 'product'
        ? await db.product.findUnique({ where: { slug: candidate }, select: { id: true } })
        : await db.category.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!found || found.id === excludeId) return candidate
  }
}
