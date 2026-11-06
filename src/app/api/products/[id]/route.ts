import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { upsertProductEmbedding } from '@/lib/ai/embedding'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { syncProductPost, unpublishProduct } from '@/lib/telegram'
import { uniqueSlug } from '@/lib/slug'
import {
  PRODUCT_INCLUDE,
  normalizeImages,
  pickPrimaryImageUrl,
  productPatchSchema,
  serializeProduct,
} from '../shared'

export const GET = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const product = await db.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    return ok({ product: serializeProduct(product) })
  },
)

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.product.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'محصول یافت نشد')

    const body = productPatchSchema.parse(await readJson(req))

    const categoryId =
      body.categoryId === undefined ? undefined : body.categoryId?.trim() || null
    if (categoryId) {
      const category = await db.category.findUnique({ where: { id: categoryId } })
      if (!category) throw new ApiError(400, 'دسته‌بندی انتخاب‌شده یافت نشد')
    }

    const data: Prisma.ProductUncheckedUpdateInput = {}
    const changedFields: string[] = []

    if (body.name !== undefined && body.name !== existing.name) {
      data.name = body.name
      data.slug = await uniqueSlug(body.name, 'product', existing.id)
      changedFields.push('name')
    }
    if (body.price !== undefined) {
      data.price = body.price
      changedFields.push('price')
    }
    if (body.compareAtPrice !== undefined) {
      data.compareAtPrice = body.compareAtPrice
      changedFields.push('compareAtPrice')
    }
    if (body.stock !== undefined) {
      data.stock = body.stock
      changedFields.push('stock')
    }
    if (categoryId !== undefined) {
      data.categoryId = categoryId
      changedFields.push('categoryId')
    }
    if (body.imageUrl !== undefined) {
      data.imageUrl = body.imageUrl
      changedFields.push('imageUrl')
    }
    if (body.shortDescription !== undefined) {
      data.shortDescription = body.shortDescription
      changedFields.push('shortDescription')
    }
    if (body.description !== undefined) {
      data.description = body.description
      changedFields.push('description')
    }
    if (body.aiGenerated !== undefined && body.aiGenerated !== null) {
      data.aiGenerated = body.aiGenerated
      changedFields.push('aiGenerated')
    }
    if (body.tags !== undefined && body.tags !== null) {
      data.tags = body.tags.length ? JSON.stringify(body.tags) : null
      changedFields.push('tags')
    }

    // ── Silver specs (optional; undefined = untouched, null = cleared) ────────
    const specFields = [
      'sku', 'silverType', 'purity', 'size', 'dimensions',
      'brand', 'appearance', 'careInstructions', 'authenticity',
    ] as const
    for (const f of specFields) {
      const v = body[f]
      if (v !== undefined) {
        data[f] = v
        changedFields.push(f)
      }
    }
    if (body.weightGrams !== undefined) {
      data.weightGrams = body.weightGrams
      changedFields.push('weightGrams')
    }

    // ── Gallery replacement (explicit payload = full sync) ───────────────────
    if (body.images !== undefined) {
      const gallery = normalizeImages(body.images)
      const primary = pickPrimaryImageUrl(gallery)
      if (primary) {
        data.imageUrl = primary
        changedFields.push('imageUrl(gallery-primary)')
      }
      changedFields.push('images')
    }

    // Inventory ↔ status sync. Inventory integrity always wins:
    // stock 0 ⇒ never 'active' (becomes out_of_stock); stock back > 0 from out_of_stock ⇒ active.
    const explicitStatus = body.status
    if (explicitStatus !== undefined) {
      data.status = explicitStatus
      changedFields.push('status')
    }
    if (body.stock !== undefined) {
      const currentStatus: string = explicitStatus ?? existing.status
      if (body.stock === 0 && currentStatus === 'active') {
        data.status = 'out_of_stock'
        changedFields.push('status(inventory:zero)')
      } else if (body.stock > 0 && currentStatus === 'out_of_stock') {
        data.status = 'active'
        changedFields.push('status(inventory:restocked)')
      }
    }

    const updated = await db.$transaction(async (tx) => {
      if (body.images !== undefined) {
        // full replacement — keeps ids/state consistent with the form
        await tx.productImage.deleteMany({ where: { productId: id } })
        const gallery = normalizeImages(body.images)
        if (gallery.length) {
          await tx.productImage.createMany({
            data: gallery.map((g) => ({ productId: id, url: g.url, isPrimary: g.isPrimary, sortOrder: g.sortOrder })),
          })
        }
      }
      return tx.product.update({ where: { id }, data, include: PRODUCT_INCLUDE })
    })

    // Keep an existing channel post in sync (price/stock/name/…). Best-effort:
    // guarded by mapping existence so a post is never created from here.
    if (updated.telegramProducts.length > 0) {
      syncProductPost(updated).catch(() => undefined)
    }

    await logEvent(
      'product.updated',
      `محصول «${updated.name}» به‌روزرسانی شد`,
      { productId: updated.id, fields: changedFields },
    )

    void upsertProductEmbedding(updated.id).catch(() => undefined)

    return ok({ product: serializeProduct(updated) })
  },
)

export const DELETE = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const product = await db.product.findUnique({ where: { id } })
    if (!product) throw new ApiError(404, 'محصول یافت نشد')

    // Best-effort channel post removal (deleteMessage + mapping cleanup).
    await unpublishProduct(product).catch(() => undefined)

    // telegramProducts / embedding cascade; orderItems.product is SetNull.
    await db.product.delete({ where: { id } })

    await logEvent('product.deleted', `محصول «${product.name}» حذف شد`, {
      productId: product.id,
    })

    return ok({ ok: true })
  },
)
