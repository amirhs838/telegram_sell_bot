import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'

export const PRODUCT_STATUSES = ['draft', 'active', 'inactive', 'out_of_stock'] as const

export const PRODUCT_INCLUDE = {
  category: true,
  telegramProducts: true,
  images: true,
} as const

export const productImageInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'آدرس تصویر الزامی است')
    .max(500, 'آدرس تصویر بیش از حد طولانی است')
    .refine(
      (v) => v.startsWith('/api/uploads/') || /^https?:\/\//i.test(v),
      'آدرس تصویر باید مسیر آپلود (/api/uploads/…) یا لینک کامل http(s) باشد',
    ),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const productCreateSchema = z.object({
  name: z.string().trim().min(1, 'نام محصول الزامی است').max(200),
  price: z.number().min(0, 'قیمت نمی‌تواند منفی باشد'),
  compareAtPrice: z.number().min(0).nullish(),
  stock: z.number().int().min(0, 'موجودی نمی‌تواند منفی باشد'),
  status: z.enum(PRODUCT_STATUSES).optional().default('draft'),
  categoryId: z.string().nullish(),
  imageUrl: z.string().max(500).nullish(),
  shortDescription: z.string().max(300).nullish(),
  description: z.string().max(5000).nullish(),
  aiGenerated: z.boolean().nullish(),
  tags: z.array(z.string()).max(10, 'حداکثر ۱۰ برچسب مجاز است').nullish(),
  // ─── Silver Love specs (optional, never priced) ───
  productCode: z.string().trim().max(100, 'کد محصول حداکثر ۱۰۰ کاراکتر است').nullish(),
  silverType: z.string().trim().max(200).nullish(),
  fineness: z
    .number()
    .int('عیار باید عدد صحیح باشد')
    .min(0, 'عیار نمی‌تواند منفی باشد')
    .max(1000, 'عیار حداکثر ۱۰۰۰ است')
    .nullish(),
  weightGrams: z.number().gt(0, 'وزن باید بزرگ‌تر از صفر باشد').nullish(),
  size: z.string().trim().max(100).nullish(),
  dimensions: z.string().trim().max(200).nullish(),
  brand: z.string().trim().max(200).nullish(),
  appearance: z.string().trim().max(1000).nullish(),
  careInstructions: z.string().trim().max(2000).nullish(),
  authenticityNote: z.string().trim().max(2000).nullish(),
  // ─── Gallery (replaces the whole set when provided) ───
  images: z.array(productImageInputSchema).max(20, 'حداکثر ۲۰ تصویر مجاز است').nullish(),
})

export const productPatchSchema = productCreateSchema.partial().extend({
  status: z.enum(PRODUCT_STATUSES).optional(),
})

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { category: true; telegramProducts: true; images: true }
}>

export type ProductGalleryInput = z.infer<typeof productImageInputSchema>

export type NormalizedGalleryImage = {
  url: string
  isPrimary: boolean
  sortOrder: number
}

/**
 * Normalizes a gallery input array:
 *  - dedupes by url (first occurrence wins)
 *  - keeps the provided order when no sortOrder is given
 *  - guarantees exactly one primary image (the first marked one wins;
 *    when none is marked the first image becomes primary)
 */
export function normalizeGalleryInput(
  images: ProductGalleryInput[] | null | undefined,
): NormalizedGalleryImage[] {
  if (!images?.length) return []
  const seen = new Set<string>()
  const normalized: NormalizedGalleryImage[] = []
  images.forEach((img, i) => {
    const url = img.url.trim()
    if (!url || seen.has(url)) return
    seen.add(url)
    normalized.push({ url, isPrimary: img.isPrimary ?? false, sortOrder: img.sortOrder ?? i })
  })
  const firstMarked = normalized.findIndex((img) => img.isPrimary)
  const primaryIndex = firstMarked === -1 ? 0 : firstMarked
  return normalized.map((img, i) => ({ ...img, isPrimary: i === primaryIndex }))
}

/**
 * Detects a unique-constraint violation on Product.productCode.
 * When Prisma does not expose the target column (SQLite) we assume productCode,
 * because slug conflicts are already avoided by uniqueSlug().
 */
export function isProductCodeViolation(e: unknown): boolean {
  if (
    !(e instanceof Prisma.PrismaClientKnownRequestError) ||
    e.code !== 'P2002'
  ) {
    return false
  }
  const target = (e.meta as { target?: unknown } | undefined)?.target
  if (target === undefined || target === null) return true
  const targetStr = Array.isArray(target) ? target.join(',') : String(target)
  return targetStr.includes('productCode')
}

/**
 * Replaces the whole gallery of a product (PATCH semantics):
 *  - upserts rows by url, deletes removed urls
 *  - keeps exactly one primary image
 *  - syncs Product.imageUrl to the primary image url
 * Returns the new primary url (null when the gallery becomes empty).
 */
export async function replaceProductGallery(
  productId: string,
  images: ProductGalleryInput[],
): Promise<{ primaryUrl: string | null }> {
  const normalized = normalizeGalleryInput(images)
  const primaryUrl = normalized.find((img) => img.isPrimary)?.url ?? null

  await db.$transaction(async (tx) => {
    const existing = await tx.productImage.findMany({ where: { productId } })
    const existingByUrl = new Map(existing.map((row) => [row.url, row]))
    const keptUrls = new Set(normalized.map((img) => img.url))

    const removedIds = existing.filter((row) => !keptUrls.has(row.url)).map((row) => row.id)
    if (removedIds.length) {
      await tx.productImage.deleteMany({ where: { id: { in: removedIds } } })
    }

    for (const img of normalized) {
      const match = existingByUrl.get(img.url)
      if (match) {
        await tx.productImage.update({
          where: { id: match.id },
          data: { isPrimary: img.isPrimary, sortOrder: img.sortOrder },
        })
      } else {
        await tx.productImage.create({
          data: {
            productId,
            url: img.url,
            isPrimary: img.isPrimary,
            sortOrder: img.sortOrder,
          },
        })
      }
    }

    await tx.product.update({ where: { id: productId }, data: { imageUrl: primaryUrl } })
  })

  return { primaryUrl }
}

export function parseTags(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String)
    return null
  } catch {
    return null
  }
}

/** Map a Prisma product (with category + telegramProducts + images) to the API contract shape. */
export function serializeProduct(p: ProductWithRelations) {
  const post = p.telegramProducts[0]
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    shortDescription: p.shortDescription,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    stock: p.stock,
    lowStockThreshold: p.lowStockThreshold,
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    imageUrl: p.imageUrl,
    status: p.status,
    aiGenerated: p.aiGenerated,
    tags: parseTags(p.tags),
    // ─── Silver Love specs ───
    productCode: p.productCode,
    silverType: p.silverType,
    fineness: p.fineness,
    weightGrams: p.weightGrams,
    size: p.size,
    dimensions: p.dimensions,
    brand: p.brand,
    appearance: p.appearance,
    careInstructions: p.careInstructions,
    authenticityNote: p.authenticityNote,
    // ─── Gallery (ordered by sortOrder, then creation order) ───
    images: [...(p.images ?? [])]
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((img) => ({
        id: img.id,
        url: img.url,
        isPrimary: img.isPrimary,
        sortOrder: img.sortOrder,
      })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    telegramPost: post
      ? { messageId: post.messageId, channelId: post.channelId, publishedAt: post.publishedAt }
      : null,
  }
}
