import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { uniqueSlug } from '@/lib/slug'

const patchSchema = z.object({
  name: z.string().trim().min(1, 'نام دسته‌بندی الزامی است').max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  // تغییر دستهٔ والد — null = تبدیل به دستهٔ اصلی
  parentId: z.string().trim().nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

/**
 * Walks up from `categoryId` collecting the ancestor chain — used to reject
 * parent assignments that would create a cycle (e.g. a parent moved under its
 * own subcategory).
 */
async function ancestorIdsOf(categoryId: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let cursor = await db.category.findUnique({
    where: { id: categoryId },
    select: { parentId: true },
  })
  while (cursor?.parentId && !ids.has(cursor.parentId)) {
    ids.add(cursor.parentId)
    cursor = await db.category.findUnique({
      where: { id: cursor.parentId },
      select: { parentId: true },
    })
  }
  return ids
}

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.category.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'دسته‌بندی یافت نشد')

    const body = patchSchema.parse(await readJson(req))

    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
      if (body.parentId === id) {
        throw new ApiError(400, 'یک دسته‌بندی نمی‌تواند زیر‌مجموعهٔ خودش باشد')
      }
      const parent = await db.category.findUnique({ where: { id: body.parentId } })
      if (!parent) throw new ApiError(400, 'دستهٔ والد یافت نشد')
      // cycle guard: the new parent must not be a descendant of this category
      const ancestors = await ancestorIdsOf(body.parentId)
      if (ancestors.has(id)) {
        throw new ApiError(400, 'انتقال ممکن نیست — دستهٔ والد انتخابی، زیر‌مجموعهٔ همین دسته است')
      }
    }

    const data: {
      name?: string
      slug?: string
      description?: string | null
      parentId?: string | null
      sortOrder?: number
    } = {}
    if (body.description !== undefined) data.description = body.description
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (body.parentId !== undefined) data.parentId = body.parentId || null
    if (body.name !== undefined && body.name !== existing.name) {
      data.name = body.name
      data.slug = await uniqueSlug(body.name, 'category', existing.id)
    }

    const category = await db.category.update({ where: { id }, data })
    return ok({ category })
  },
)

export const DELETE = route<{ params: Promise<{ id: string }> }>(
  async (_req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.category.findUnique({
      where: { id },
      include: { _count: { select: { children: true } } },
    })
    if (!existing) throw new ApiError(404, 'دسته‌بندی یافت نشد')

    // schema-level onDelete:
    //  - products.categoryId  → SetNull (products stay, they just lose the category)
    //  - children.parentId    → SetNull (subcategories are promoted to main level)
    await db.category.delete({ where: { id } })

    await logEvent(
      'category.deleted',
      `دسته‌بندی «${existing.name}» حذف شد${existing._count.children > 0 ? ` — ${existing._count.children} زیر‌مجموعه به سطح اصلی منتقل شد` : ''}`,
      { categoryId: existing.id },
    )

    return ok({ ok: true })
  },
)
