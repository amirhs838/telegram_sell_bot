import type { NextRequest } from 'next/server'
import { ApiError, ok, requireAuth, route } from '@/lib/api'
import { db } from '@/lib/db'

/**
 * Live product-code availability check for the admin product form.
 * GET /api/products/check-code?code=SL-1024&excludeId=<productId?>
 * → { available: boolean }
 *
 * The DB unique index is the hard guarantee; this endpoint only gives the
 * admin an immediate, friendly «duplicate» warning while typing.
 * Matching is trim- + case-insensitive so «SL-1024» and «sl-1024» collide.
 */
export const GET = route(async (req: NextRequest) => {
  await requireAuth()

  const code = req.nextUrl.searchParams.get('code')?.trim() ?? ''
  if (!code) throw new ApiError(400, 'کد محصول را وارد کنید')
  if (code.length > 100) throw new ApiError(400, 'کد محصول حداکثر ۱۰۰ کاراکتر است')

  const excludeId = req.nextUrl.searchParams.get('excludeId')?.trim() || null

  const rows = await db.product.findMany({
    where: { productCode: { not: null } },
    select: { id: true, productCode: true },
  })
  const wanted = code.toLowerCase()
  const available = !rows.some(
    (r) => (r.productCode ?? '').trim().toLowerCase() === wanted && r.id !== excludeId,
  )

  return ok({ available })
})
