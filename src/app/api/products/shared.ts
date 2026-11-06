import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const PRODUCT_STATUSES = ['draft', 'active', 'inactive', 'out_of_stock'] as const

export const PRODUCT_INCLUDE = { category: true, telegramProducts: true, images: true } as const

// ─── Silver Love — optional product specs (NEVER used for pricing) ──────────
const silverSpecsSchema = {
  sku: z.string().trim().max(60).nullish(),
  silverType: z.string().trim().max(80).nullish(),
  purity: z.string().trim().max(20).nullish(),
  weightGrams: z.number().min(0).nullish(),
  size: z.string().trim().max(60).nullish(),
  dimensions: z.string().trim().max(120).nullish(),
  brand: z.string().trim().max(120).nullish(),
  appearance: z.string().trim().max(500).nullish(),
  careInstructions: z.string().trim().max(500).nullish(),
  authenticity: z.string().trim().max(500).nullish(),
}

const productImagesSchema = z
  .array(
    z.object({
      url: z.string().min(1).max(500),
      isPrimary: z.boolean().optional(),
    }),
  )
  .max(12, 'حداکثر ۱۲ تصویر برای هر محصول مجاز است')
  .nullish()

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
  ...silverSpecsSchema,
  images: productImagesSchema,
})

export const productPatchSchema = productCreateSchema.partial().extend({
  status: z.enum(PRODUCT_STATUSES).optional(),
})

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { category: true; telegramProducts: true; images: true }
}>

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

/**
 * Pick the primary gallery URL (mirrored into Product.imageUrl so channel
 * publishing and the bot keep working without extra lookups).
 */
export function pickPrimaryImageUrl(
  images: Array<{ url: string; isPrimary: boolean }>,
): string | null {
  if (images.length === 0) return null
  return images.find((i) => i.isPrimary)?.url ?? images[0].url
}

/** Normalize an incoming images payload into rows with deterministic order. */
export function normalizeImages(
  images: Array<{ url: string; isPrimary?: boolean }> | null | undefined,
): Array<{ url: string; isPrimary: boolean; sortOrder: number }> {
  if (!images || images.length === 0) return []
  const hasExplicitPrimary = images.some((i) => i.isPrimary)
  return images.map((img, idx) => ({
    url: img.url,
    isPrimary: hasExplicitPrimary ? Boolean(img.isPrimary) : idx === 0,
    sortOrder: idx,
  }))
}

/** Map a Prisma product (with category + telegramProducts + images) to the API contract. */
export function serializeProduct(p: ProductWithRelations) {
  const post = p.telegramProducts[0]
  const images = [...p.images].sort((a, b) => a.sortOrder - b.sortOrder)
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
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    // Silver specs
    sku: p.sku,
    silverType: p.silverType,
    purity: p.purity,
    weightGrams: p.weightGrams,
    size: p.size,
    dimensions: p.dimensions,
    brand: p.brand,
    appearance: p.appearance,
    careInstructions: p.careInstructions,
    authenticity: p.authenticity,
    // Gallery
    images: images.map((i) => ({ id: i.id, url: i.url, isPrimary: i.isPrimary, sortOrder: i.sortOrder })),
    telegramPost: post
      ? { messageId: post.messageId, channelId: post.channelId, publishedAt: post.publishedAt }
      : null,
  }
}
