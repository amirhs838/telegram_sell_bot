import type { Prisma } from '@prisma/client'
import type { NextRequest } from 'next/server'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { upsertProductEmbedding } from '@/lib/ai/embedding'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { uniqueSlug } from '@/lib/slug'
import {
  PRODUCT_INCLUDE,
  PRODUCT_STATUSES,
  productCreateSchema,
  serializeProduct,
} from './shared'

const SORT_FIELDS = ['createdAt', 'price', 'stock', 'name'] as const

export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const sp = req.nextUrl.searchParams
  const search = sp.get('search')?.trim()
  const status = sp.get('status')?.trim()
  const categoryId = sp.get('categoryId')?.trim()
  const lowStock = sp.get('lowStock')
  const sortRaw = sp.get('sort')?.trim()
  const sort = SORT_FIELDS.includes(sortRaw as (typeof SORT_FIELDS)[number])
    ? (sortRaw as (typeof SORT_FIELDS)[number])
    : 'createdAt'
  const order = sp.get('order') === 'asc' ? 'asc' : 'desc'
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(sp.get('pageSize') ?? '20', 10) || 20))

  const where: Prisma.ProductWhereInput = {}
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { shortDescription: { contains: search } },
      { description: { contains: search } },
    ]
  }
  if (status && (PRODUCT_STATUSES as readonly string[]).includes(status)) {
    where.status = status
  }
  if (categoryId) where.categoryId = categoryId
  if (lowStock === '1') where.stock = { gt: 0, lte: 5 }

  const orderBy: Prisma.ProductOrderByWithRelationInput = {
    [sort]: order,
  } as Prisma.ProductOrderByWithRelationInput

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      include: PRODUCT_INCLUDE,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.product.count({ where }),
  ])

  return ok({ items: rows.map(serializeProduct), total, page, pageSize })
})

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const body = productCreateSchema.parse(await readJson(req))

  const categoryId = body.categoryId?.trim() || null
  if (categoryId) {
    const category = await db.category.findUnique({ where: { id: categoryId } })
    if (!category) throw new ApiError(400, 'دسته‌بندی انتخاب‌شده یافت نشد')
  }

  const slug = await uniqueSlug(body.name, 'product')

  const product = await db.product.create({
    data: {
      name: body.name,
      slug,
      description: body.description ?? null,
      shortDescription: body.shortDescription ?? null,
      price: body.price,
      compareAtPrice: body.compareAtPrice ?? null,
      stock: body.stock,
      categoryId,
      imageUrl: body.imageUrl ?? null,
      status: body.status,
      aiGenerated: body.aiGenerated ?? false,
      tags: body.tags ? JSON.stringify(body.tags) : null,
    },
    include: PRODUCT_INCLUDE,
  })

  await logEvent('product.created', `محصول «${product.name}» ایجاد شد`, {
    productId: product.id,
  })

  void upsertProductEmbedding(product.id).catch(() => undefined)

  return ok({ product: serializeProduct(product) }, 201)
})
