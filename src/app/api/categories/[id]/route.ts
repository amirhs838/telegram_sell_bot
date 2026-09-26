import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError, ok, readJson, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'
import { logEvent } from '@/lib/logger'
import { uniqueSlug } from '@/lib/slug'

const patchSchema = z.object({
  name: z.string().trim().min(1, 'نام دسته‌بندی الزامی است').max(80).optional(),
  description: z.string().max(500).nullable().optional(),
})

export const PATCH = route<{ params: Promise<{ id: string }> }>(
  async (req: NextRequest, { params }) => {
    await requireAuth()
    const { id } = await params

    const existing = await db.category.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'دسته‌بندی یافت نشد')

    const body = patchSchema.parse(await readJson(req))

    const data: { name?: string; slug?: string; description?: string | null } = {}
    if (body.description !== undefined) data.description = body.description
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

    const existing = await db.category.findUnique({ where: { id } })
    if (!existing) throw new ApiError(404, 'دسته‌بندی یافت نشد')

    // products.categoryId is SetNull — products stay, they just lose the category.
    await db.category.delete({ where: { id } })

    await logEvent('category.deleted', `دسته‌بندی «${existing.name}» حذف شد`, {
      categoryId: existing.id,
    })

    return ok({ ok: true })
  },
)
