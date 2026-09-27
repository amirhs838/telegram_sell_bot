import type { Prisma } from '@prisma/client'
import { z } from 'zod'

export const PRODUCT_STATUSES = ['draft', 'active', 'inactive', 'out_of_stock'] as const

export const PRODUCT_INCLUDE = { category: true, telegramProducts: true } as const

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
})

export const productPatchSchema = productCreateSchema.partial().extend({
  status: z.enum(PRODUCT_STATUSES).optional(),
})

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { category: true; telegramProducts: true }
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

/** Map a Prisma product (with category + telegramProducts) to the API contract shape. */
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
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    telegramPost: post
      ? { messageId: post.messageId, channelId: post.channelId, publishedAt: post.publishedAt }
      : null,
  }
}
