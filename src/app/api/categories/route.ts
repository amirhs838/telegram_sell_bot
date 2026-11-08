import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { uniqueSlug } from '@/lib/slug'

const createSchema = z.object({
  name: z.string().trim().min(1, 'نام دسته‌بندی الزامی است').max(80),
  description: z.string().max(500).optional(),
  // دستهٔ والد — خالی = دستهٔ اصلی (سطح اول منوی محصولات ربات)
  parentId: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const GET = route(async () => {
  await requireAuth()

  const categories = await db.category.findMany({
    // Menu order = manual sortOrder, then creation order (matches the bot's
    // «🛍 محصولات» keyboard — owner-approved layout), NOT alphabetical.
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      _count: { select: { products: true, children: true } },
    },
  })

  return ok({
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      parentId: c.parentId,
      sortOrder: c.sortOrder,
      productCount: c._count.products,
      childCount: c._count.children,
      createdAt: c.createdAt,
    })),
  })
})

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const body = createSchema.parse(await readJson(req))

  if (body.parentId) {
    const parent = await db.category.findUnique({ where: { id: body.parentId } })
    if (!parent) throw new ApiError(400, 'دستهٔ والد یافت نشد')
  }

  const slug = await uniqueSlug(body.name, 'category')

  const category = await db.category.create({
    data: {
      name: body.name,
      slug,
      description: body.description ?? null,
      parentId: body.parentId || null,
      sortOrder: body.sortOrder ?? 0,
    },
  })

  await logEvent(
    'category.created',
    `دسته‌بندی «${category.name}» ایجاد شد${body.parentId ? ' (زیر‌مجموعه)' : ''}`,
    { categoryId: category.id, parentId: category.parentId },
  )

  return ok({ category }, 201)
})
