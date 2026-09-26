import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { uniqueSlug } from '@/lib/slug'

const createSchema = z.object({
  name: z.string().trim().min(1, 'نام دسته‌بندی الزامی است').max(80),
  description: z.string().max(500).optional(),
})

export const GET = route(async () => {
  await requireAuth()

  const categories = await db.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  })

  return ok({
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      productCount: c._count.products,
      createdAt: c.createdAt,
    })),
  })
})

export const POST = route(async (req: NextRequest) => {
  await requireAuth()

  const body = createSchema.parse(await readJson(req))
  const slug = await uniqueSlug(body.name, 'category')

  const category = await db.category.create({
    data: {
      name: body.name,
      slug,
      description: body.description ?? null,
    },
  })

  await logEvent('category.created', `دسته‌بندی «${category.name}» ایجاد شد`, {
    categoryId: category.id,
  })

  return ok({ category }, 201)
})
